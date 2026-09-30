#[cfg(test)]
use std::collections::HashMap;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[cfg(test)]
use crate::fs::GitDiffStats;
use crate::fs::{
    expand_home, git_checked, git_diff_files_for, path_to_js, resolve_repo_path, GitChangedFile,
    GitDiffIndex, MAX_TEXT_FILE_BYTES,
};

const MAX_SNAPSHOT_FILES: usize = 500;
/// Matches the control service's per-task limit.
const MAX_WRITE_SCOPES: usize = 64;

#[derive(Clone)]
pub struct CheckpointStore {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}

impl CheckpointStore {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Arc::new(Mutex::new(())),
        }
    }

    fn exclusive<T>(
        &self,
        operation: impl FnOnce(&Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| "Checkpoint store lock poisoned".to_string())?;
        operation(self)
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.root.join(session_id)
    }

    /// `isolated` marks a checkout only this session writes: an orchestration
    /// worker's worktree. Its turn-start contents stay the baseline.
    fn ensure(&self, session_id: &str, cwd: &str, isolated: bool) -> Result<(), String> {
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        if let Some(manifest) = read_manifest(&dir)? {
            if same_cwd(&manifest.cwd, cwd) {
                return Ok(());
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        std::fs::create_dir_all(dir.join("files")).map_err(|e| e.to_string())?;

        let mut files = BTreeMap::new();
        let mut tracked = BTreeSet::new();
        for file in git_diff_files_for(&root).files {
            if files.len() >= MAX_SNAPSHOT_FILES {
                break;
            }
            let Ok(relative) = resolve_repo_path(&root, &file.relative) else {
                continue;
            };
            if in_head(&root, &relative) {
                tracked.insert(relative.clone());
            }
            files.insert(relative.clone(), snapshot_file(&dir, &root, &relative)?);
        }
        write_manifest(
            &dir,
            &Manifest {
                cwd: root.to_string_lossy().into_owned(),
                files,
                touched: BTreeSet::new(),
                tracked,
                prepared: BTreeSet::new(),
                after: BTreeMap::new(),
                stats: BTreeMap::new(),
                diverged: BTreeSet::new(),
                isolated,
            },
        )
    }

    fn prepare(&self, session_id: &str, cwd: &str, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let mut manifest = match read_manifest(&dir)? {
            Some(manifest) if same_cwd(&manifest.cwd, cwd) => manifest,
            _ => return Ok(()),
        };

        let mut dirty = false;
        for path in paths {
            let Ok(relative) = relative_to_root(&root, path) else {
                continue;
            };
            if manifest.isolated {
                // Nothing else writes an isolated checkout, so its baseline is
                // what the session started from, even when the session already
                // changed this file through a shell command.
                if !manifest.files.contains_key(&relative) {
                    let before = snapshot_checkout_file(&dir, &root, &relative)?;
                    manifest.files.insert(relative.clone(), before);
                    dirty = true;
                }
                dirty |= manifest.prepared.insert(relative.clone());
                if in_head(&root, &relative) {
                    dirty |= manifest.tracked.insert(relative);
                }
                continue;
            }
            // Keep the original pre-edit snapshot across later edits by this
            // session. The first tool-start event owns the safe undo boundary.
            if manifest.touched.contains(&relative) && manifest.prepared.contains(&relative) {
                if !after_matches_worktree(&dir, &root, &manifest, &relative)
                    && manifest.diverged.insert(relative)
                {
                    dirty = true;
                }
                continue;
            }
            if manifest.prepared.contains(&relative) {
                continue;
            }
            if manifest.touched.contains(&relative) {
                // Upgrade a legacy or completion-only claim by dropping its
                // untrusted state and starting at this real tool boundary.
                release_path(&mut manifest, &relative);
                dirty = true;
            }
            let before = snapshot_file(&dir, &root, &relative)?;
            if manifest.files.insert(relative.clone(), before) != Some(before) {
                dirty = true;
            }
            if manifest.prepared.insert(relative.clone()) {
                dirty = true;
            }
            if in_head(&root, &relative) && manifest.tracked.insert(relative) {
                dirty = true;
            }
        }
        if dirty {
            write_manifest(&dir, &manifest)?;
        }
        Ok(())
    }

    fn capture(&self, session_id: &str, cwd: &str, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let mut manifest = match read_manifest(&dir)? {
            Some(manifest) if same_cwd(&manifest.cwd, cwd) => manifest,
            _ => return Ok(()),
        };

        let mut dirty = false;
        for path in paths {
            if manifest.touched.len() >= MAX_SNAPSHOT_FILES {
                break;
            }
            let Ok(relative) = relative_to_root(&root, path) else {
                continue;
            };
            manifest.touched.insert(relative.clone());
            let tracked_in_head = in_head(&root, &relative);
            if tracked_in_head {
                manifest.tracked.insert(relative.clone());
            }
            if !manifest.files.contains_key(&relative)
                && !root.join(&relative).exists()
                && !tracked_in_head
            {
                // A completion without a matching prepare event is retained
                // for review but is deliberately not undoable.
                manifest
                    .files
                    .insert(relative.clone(), snapshot_file(&dir, &root, &relative)?);
            }
            let after = snapshot_after_file(&dir, &root, &relative)?;
            manifest.after.insert(relative.clone(), after);
            if let Some(stats) = calculate_session_stats(&dir, &manifest, &relative) {
                manifest.stats.insert(relative, stats);
            }
            dirty = true;
        }
        if dirty {
            write_manifest(&dir, &manifest)?;
        }
        Ok(())
    }

    fn status(&self, session_id: &str, cwd: &str) -> Result<CheckpointStatus, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let foreign_touched = self.foreign_touched_paths(cwd, session_id);
        Ok(diff_from_manifest(
            &self.session_dir(session_id),
            &root,
            &manifest,
            &foreign_touched,
        ))
    }

    /// Record an isolated worker's whole turn when its dispatch completes.
    /// Nothing else writes its checkout, so every in-scope difference from the
    /// baseline is the worker's own, including edits made through shell
    /// commands that never reported a tool event. Changes outside `scopes` are
    /// never claimed, and integration keeps rejecting them.
    fn reconcile(&self, session_id: &str, cwd: &str, scopes: &[String]) -> Result<(), String> {
        let Some(mut manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(());
        };
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let scopes = write_scopes(&root, scopes)?;
        manifest.isolated = true;

        let mut candidates: BTreeSet<String> = git_diff_files_for(&root)
            .files
            .into_iter()
            .map(|file| file.relative)
            .collect();
        candidates.extend(manifest.files.keys().cloned());
        candidates.extend(manifest.touched.iter().cloned());
        for relative in candidates {
            let Ok(relative) = resolve_repo_path(&root, &relative) else {
                continue;
            };
            if !in_write_scope(&scopes, &relative) {
                continue;
            }
            let touched = manifest.touched.contains(&relative);
            if !touched && manifest.touched.len() >= MAX_SNAPSHOT_FILES {
                continue;
            }
            let before = match manifest.files.get(&relative) {
                Some(kind) => *kind,
                None => snapshot_checkout_file(&dir, &root, &relative)?,
            };
            if !touched
                && worktree_snapshot(&root, &relative)
                    == stored_snapshot(&dir, &relative, before, false)
            {
                continue;
            }
            manifest.files.insert(relative.clone(), before);
            manifest.touched.insert(relative.clone());
            manifest.prepared.insert(relative.clone());
            if in_head(&root, &relative) {
                manifest.tracked.insert(relative.clone());
            }
            let after = snapshot_after_file(&dir, &root, &relative)?;
            manifest.after.insert(relative.clone(), after);
            // Divergence between two tool edits was this worker's own shell
            // edit; the turn-end snapshot above is exact again.
            manifest.diverged.remove(&relative);
            match calculate_session_stats(&dir, &manifest, &relative) {
                Some(stats) => manifest.stats.insert(relative, stats),
                None => manifest.stats.remove(&relative),
            };
        }
        write_manifest(&dir, &manifest)
    }

    fn apply(
        &self,
        session_id: &str,
        from_cwd: &str,
        to_cwd: &str,
        scopes: &[String],
    ) -> Result<CheckpointApplyResult, String> {
        let manifest = self
            .load_matching(session_id, from_cwd)?
            .ok_or("This worker has no recoverable change checkpoint")?;
        let from_root = project_root(from_cwd)?;
        let to_root = project_root(to_cwd)?;
        if same_cwd(from_cwd, to_cwd) {
            return Err("An isolated worker cannot be integrated into itself".into());
        }
        if git_head(&from_root)? != git_head(&to_root)? {
            return Err(
                "The worker or lead branch moved while this task was running. The worker worktree was kept for manual review."
                    .into(),
            );
        }
        let dir = self.session_dir(session_id);
        let changed = verified_worker_delta(&dir, &from_root, &manifest)?;
        let scopes = write_scopes(&from_root, scopes)?;
        if let Some(relative) = changed
            .iter()
            .find(|relative| !in_write_scope(&scopes, relative))
        {
            return Err(format!(
                "Cannot integrate {relative}: it is outside this task's write scope. The worker worktree was kept."
            ));
        }

        // Preflight every path before writing any of them. A retry may see a
        // mixture of before/after states if the app stopped during a previous
        // application; both are safe and make this operation idempotent.
        // Byte equality decides first; otherwise Git's own view does, so a
        // checkout's line-ending conversion is not mistaken for a lead edit.
        let mut already_applied = 0;
        let mut writes = Vec::new();
        for relative in &changed {
            if path_contains_symlink(&to_root, relative) {
                return Err(format!(
                    "Cannot integrate {relative}: the target path contains a symbolic link. The worker worktree was kept."
                ));
            }
            let before = manifest
                .files
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing original snapshot for {relative}"))?;
            let after = manifest
                .after
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing worker snapshot for {relative}"))?;
            let target = worktree_snapshot(&to_root, relative);
            let before_state = stored_snapshot(&dir, relative, before, false);
            let after_state = stored_snapshot(&dir, relative, after, true);
            if target == after_state {
                already_applied += 1;
            } else if target == before_state {
                writes.push((relative, after_state));
            } else if same_in_git(&to_root, relative, &target, &after_state) {
                already_applied += 1;
            } else if same_in_git(&to_root, relative, &target, &before_state) {
                writes.push((
                    relative,
                    in_lead_line_endings(&before_state, &target, after_state),
                ));
            } else {
                return Err(format!(
                    "Cannot integrate {relative}: the lead checkout changed since this worker started. The worker worktree was kept."
                ));
            }
        }

        for (relative, (state, mode)) in writes {
            write_state(&to_root, relative, state, mode)?;
        }
        Ok(CheckpointApplyResult {
            files: changed,
            already_applied,
        })
    }

    fn cleanup_safe(&self, session_id: &str, cwd: &str) -> Result<bool, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(false);
        };
        let root = project_root(cwd)?;
        Ok(
            verified_worker_delta(&self.session_dir(session_id), &root, &manifest)
                .map(|changed| changed.is_empty())
                .unwrap_or(false),
        )
    }

    fn forget(&self, session_id: &str) -> Result<(), String> {
        let dir = self.session_dir(session_id);
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn file_diff(
        &self,
        session_id: &str,
        cwd: &str,
        relative: &str,
    ) -> Result<CheckpointFileDiff, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Err("Session changes are no longer available".into());
        };
        let root = project_root(cwd)?;
        let relative = resolve_repo_path(&root, relative)?;
        if !manifest.touched.contains(&relative) || !manifest.prepared.contains(&relative) {
            return Err("This file was not changed by the session".into());
        }
        if manifest.diverged.contains(&relative) {
            return Err(
                "Exact lines are unavailable because the file changed between this session's edits"
                    .into(),
            );
        }

        let dir = self.session_dir(session_id);
        let before = manifest
            .files
            .get(&relative)
            .copied()
            .ok_or_else(|| "Session baseline is unavailable".to_string())?;
        let after = manifest
            .after
            .get(&relative)
            .copied()
            .ok_or_else(|| "Session result is unavailable".to_string())?;
        let original = read_snapshot(&dir, &relative, before);
        let current = read_after_snapshot(&dir, &relative, after);
        let too_large =
            matches!(original, FileState::Skipped) || matches!(current, FileState::Skipped);
        let binary = state_is_binary(&original) || state_is_binary(&current);
        let (original, current) = if binary || too_large {
            (String::new(), String::new())
        } else {
            (state_text(original), state_text(current))
        };
        let status = manifest
            .stats
            .get(&relative)
            .map(|stats| stats.status.clone())
            .unwrap_or_else(|| "modified".into());
        Ok(CheckpointFileDiff {
            path: path_to_js(&root.join(&relative)),
            relative,
            status,
            original,
            current,
            binary,
            too_large,
        })
    }

    /// Remaining git line counts for each session, using one working-tree index.
    #[cfg(test)]
    fn stats_for_sessions(
        &self,
        cwd: &str,
        session_ids: &[String],
    ) -> Result<HashMap<String, GitDiffStats>, String> {
        let mut out = HashMap::new();
        if session_ids.is_empty() {
            return Ok(out);
        }
        let root = project_root(cwd)?;
        let index = git_diff_files_for(&root);
        for session_id in session_ids {
            let Some(manifest) = self.load_matching(session_id, cwd)? else {
                out.insert(session_id.clone(), GitDiffStats::default());
                continue;
            };
            let foreign_touched = self.foreign_touched_paths(cwd, session_id);
            let status = diff_from_manifest_with(
                &index,
                &self.session_dir(session_id),
                &root,
                &manifest,
                &foreign_touched,
            );
            out.insert(session_id.clone(), stats_from_status(&status));
        }
        Ok(out)
    }

    fn undo(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<CheckpointStatus, String> {
        let Some(mut manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let foreign_touched = self.foreign_touched_paths(cwd, session_id);
        let changed = diff_from_manifest(&dir, &root, &manifest, &foreign_touched);
        if let Some(relative) = relative {
            let relative = resolve_repo_path(&root, relative)?;
            let Some(file) = changed.files.iter().find(|file| file.relative == relative) else {
                return self.status(session_id, cwd);
            };
            if !file.undoable {
                return Err(format!(
                    "Cannot safely undo {relative}: it changed outside this session"
                ));
            }
            restore_one(&dir, &root, &manifest, &relative)?;
            release_path(&mut manifest, &relative);
            write_manifest(&dir, &manifest)?;
            return self.status(session_id, cwd);
        }
        if changed.files.iter().any(|file| !file.undoable) {
            return Err(
                "Cannot safely undo all: one or more files changed outside this session".into(),
            );
        }
        for file in &changed.files {
            restore_one(&dir, &root, &manifest, &file.relative)?;
        }
        let _ = std::fs::remove_dir_all(&dir);
        Ok(CheckpointStatus { files: Vec::new() })
    }

    fn keep(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<CheckpointStatus, String> {
        let Some(mut manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let Some(relative) = relative else {
            let _ = std::fs::remove_dir_all(&dir);
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let relative = resolve_repo_path(&root, relative)?;
        release_path(&mut manifest, &relative);
        write_manifest(&dir, &manifest)?;
        self.status(session_id, cwd)
    }

    fn load_matching(&self, session_id: &str, cwd: &str) -> Result<Option<Manifest>, String> {
        let dir = self.session_dir(session_id);
        let Some(manifest) = read_manifest(&dir)? else {
            return Ok(None);
        };
        if !same_cwd(&manifest.cwd, cwd) {
            return Ok(None);
        }
        Ok(Some(manifest))
    }

    /// Paths already claimed by another live session in the same project.
    fn foreign_touched_paths(&self, cwd: &str, except_session_id: &str) -> HashSet<String> {
        let mut paths = HashSet::new();
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(_) => return paths,
        };
        for entry in entries.flatten() {
            let session_id = entry.file_name().to_string_lossy().into_owned();
            if session_id == except_session_id {
                continue;
            }
            let dir = entry.path();
            let Ok(Some(manifest)) = read_manifest(&dir) else {
                continue;
            };
            if !same_cwd(&manifest.cwd, cwd) {
                continue;
            }
            paths.extend(manifest.touched.intersection(&manifest.prepared).cloned());
        }
        paths
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    cwd: String,
    files: BTreeMap<String, SnapshotKind>,
    #[serde(default)]
    touched: BTreeSet<String>,
    #[serde(default)]
    tracked: BTreeSet<String>,
    /// Paths captured before a structured edit started. Only these are safe
    /// candidates for Undo.
    #[serde(default)]
    prepared: BTreeSet<String>,
    /// Worktree contents immediately after the session's latest edit.
    #[serde(default)]
    after: BTreeMap<String, SnapshotKind>,
    /// Stable line counts for the session-owned before/after pair.
    #[serde(default)]
    stats: BTreeMap<String, ChangeStats>,
    /// Paths whose contents changed between two edits by this session.
    #[serde(default)]
    diverged: BTreeSet<String>,
    /// Only this session writes the checkout (an orchestration worker's
    /// worktree), so every difference from its baseline is the session's own.
    #[serde(default)]
    isolated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ChangeStats {
    status: String,
    additions: i64,
    deletions: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SnapshotKind {
    Contents,
    Missing,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileState {
    Contents(Vec<u8>),
    Missing,
    Skipped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    /// False when the file changed between this session's own edit snapshots,
    /// so its net line ownership cannot be reconstructed exactly.
    pub exact: bool,
    pub undoable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatus {
    pub files: Vec<CheckpointFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileDiff {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub original: String,
    pub current: String,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointApplyResult {
    pub files: Vec<String>,
    pub already_applied: usize,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("checkpoints");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.manage(CheckpointStore::new(dir));
    Ok(())
}

#[tauri::command]
pub async fn session_checkpoint_ensure(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    isolated: Option<bool>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    let isolated = isolated.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.ensure(&session_id, &cwd, isolated))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_prepare(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if paths.len() > MAX_SNAPSHOT_FILES {
        return Err("Too many paths".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.prepare(&session_id, &cwd, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_capture(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if paths.len() > MAX_SNAPSHOT_FILES {
        return Err("Too many paths".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.capture(&session_id, &cwd, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_status(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.status(&session_id, &cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Capture an isolated worker checkout at turn end. Only call this for a
/// checkout no other session writes.
#[tauri::command]
pub async fn session_checkpoint_reconcile(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    scopes: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if scopes.len() > MAX_WRITE_SCOPES {
        return Err("Too many write scopes".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.reconcile(&session_id, &cwd, &scopes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_apply(
    store: State<'_, CheckpointStore>,
    session_id: String,
    from_cwd: String,
    to_cwd: String,
    scopes: Vec<String>,
) -> Result<CheckpointApplyResult, String> {
    validate_id(&session_id, "session")?;
    if scopes.len() > MAX_WRITE_SCOPES {
        return Err("Too many write scopes".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.apply(&session_id, &from_cwd, &to_cwd, &scopes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_cleanup_safe(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<bool, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.cleanup_safe(&session_id, &cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_forget(
    store: State<'_, CheckpointStore>,
    session_id: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.exclusive(|store| store.forget(&session_id)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_file_diff(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: String,
) -> Result<CheckpointFileDiff, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.file_diff(&session_id, &cwd, &relative))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_undo(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: Option<String>,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.undo(&session_id, &cwd, relative.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_keep(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: Option<String>,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.keep(&session_id, &cwd, relative.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reconstruct the worker-owned delta and reject anything that was not
/// captured at a structured tool boundary. This is stricter than the review
/// UI because cleanup must never discard an ambiguous edit.
fn verified_worker_delta(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
) -> Result<Vec<String>, String> {
    if !manifest.diverged.is_empty() {
        return Err(format!(
            "Cannot safely integrate files that changed outside the worker: {}",
            manifest
                .diverged
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let current_dirty: BTreeSet<String> = git_diff_files_for(root)
        .files
        .into_iter()
        .map(|file| file.relative)
        .collect();
    if let Some(relative) = current_dirty
        .iter()
        .find(|relative| !manifest.files.contains_key(*relative))
    {
        return Err(format!(
            "Cannot safely integrate {relative}: its change was not captured for this worker. Only changes inside the task's write scope are integrated: have the worker revert it, or retry with corrected files if it is required. The worker worktree was kept."
        ));
    }

    let mut changed = Vec::new();
    for (relative, before) in &manifest.files {
        if path_contains_symlink(root, relative) {
            return Err(format!(
                "Cannot safely integrate {relative}: the worker path contains a symbolic link. The worker worktree was kept."
            ));
        }
        if *before == SnapshotKind::Skipped {
            return Err(format!(
                "Cannot safely integrate {relative}: this file type or size cannot be checkpointed. The worker worktree was kept."
            ));
        }
        let before_state = stored_snapshot(dir, relative, *before, false);
        if manifest.touched.contains(relative) {
            if !manifest.prepared.contains(relative) {
                return Err(format!(
                    "Cannot safely integrate {relative}: its pre-edit state was not captured. The worker worktree was kept."
                ));
            }
            let after = manifest
                .after
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing worker snapshot for {relative}"))?;
            if after == SnapshotKind::Skipped {
                return Err(format!(
                    "Cannot safely integrate {relative}: this file type or size cannot be checkpointed. The worker worktree was kept."
                ));
            }
            let after_state = stored_snapshot(dir, relative, after, true);
            if worktree_snapshot(root, relative) != after_state {
                return Err(format!(
                    "Cannot safely integrate {relative}: it changed after the worker checkpoint. The worker worktree was kept."
                ));
            }
            if before_state != after_state {
                changed.push(relative.clone());
            }
        } else if worktree_snapshot(root, relative) != before_state {
            return Err(format!(
                "Cannot safely integrate {relative}: its change was not attributed to this worker. The worker worktree was kept."
            ));
        }
    }
    changed.sort();
    Ok(changed)
}

/// A task's write scopes as checkout-relative paths. An empty scope stands
/// for the whole checkout; a directory covers its descendants.
fn write_scopes(root: &Path, scopes: &[String]) -> Result<Vec<String>, String> {
    scopes
        .iter()
        .map(|scope| {
            let slashed = scope.trim().replace('\\', "/");
            let trimmed = slashed.trim_start_matches("./").trim_end_matches('/');
            if trimmed.is_empty() || trimmed == "." {
                return Ok(String::new());
            }
            resolve_repo_path(root, trimmed).map_err(|_| format!("Invalid write scope \"{scope}\""))
        })
        .collect()
}

fn in_write_scope(scopes: &[String], relative: &str) -> bool {
    let relative = scope_key(relative);
    scopes.iter().any(|scope| {
        let scope = scope_key(scope);
        scope.is_empty()
            || relative
                .strip_prefix(scope.as_str())
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// Scopes compare like the control service's canonical paths: ignoring case
/// on Windows only.
fn scope_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

/// Whether Git sees the same file in both states: equal bytes, or contents
/// its clean filters store as one blob, such as the line endings
/// `core.autocrlf` converts. Like Git, only the executable bit of a mode counts.
fn same_in_git(
    root: &Path,
    relative: &str,
    left: &(FileState, Option<u32>),
    right: &(FileState, Option<u32>),
) -> bool {
    if left == right {
        return true;
    }
    let (
        (FileState::Contents(left_bytes), left_mode),
        (FileState::Contents(right_bytes), right_mode),
    ) = (left, right)
    else {
        return false;
    };
    let executable = |mode: &Option<u32>| mode.map(|mode| mode & 0o111 != 0);
    executable(left_mode) == executable(right_mode)
        && matches!(
            (
                git_blob_id(root, relative, left_bytes),
                git_blob_id(root, relative, right_bytes),
            ),
            (Some(left), Some(right)) if left == right
        )
}

/// The object ID Git would store for `bytes` at `relative` in this checkout.
fn git_blob_id(root: &Path, relative: &str, bytes: &[u8]) -> Option<Vec<u8>> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    let mut child = command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.safecrlf=false", "hash-object", "--stdin"])
        .arg(format!("--path={relative}"))
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let written = child.stdin.take()?.write_all(bytes);
    let output = child.wait_with_output().ok()?;
    (written.is_ok() && output.status.success()).then_some(output.stdout)
}

/// The worker's result in the lead file's line-ending style. A lead file
/// checked out under another `core.autocrlf` setting can differ from the
/// worker's fresh checkout only in line endings; writing the worker's bytes
/// verbatim would flip every line of it.
fn in_lead_line_endings(
    before: &(FileState, Option<u32>),
    target: &(FileState, Option<u32>),
    after: (FileState, Option<u32>),
) -> (FileState, Option<u32>) {
    let (FileState::Contents(before), FileState::Contents(target)) = (&before.0, &target.0) else {
        return after;
    };
    let (FileState::Contents(result), mode) = after else {
        return after;
    };
    if before == target
        || [before, target, &result]
            .iter()
            .any(|bytes| bytes.contains(&0))
    {
        return (FileState::Contents(result), mode);
    }
    let converted = if crlf_to_lf(before) == *target {
        crlf_to_lf(&result)
    } else if lf_to_crlf(before) == *target {
        lf_to_crlf(&result)
    } else {
        result
    };
    (FileState::Contents(converted), mode)
}

fn crlf_to_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\r' || bytes.get(index + 1) != Some(&b'\n') {
            out.push(*byte);
        }
    }
    out
}

fn lf_to_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 16);
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' && (index == 0 || bytes[index - 1] != b'\r') {
            out.push(b'\r');
        }
        out.push(*byte);
    }
    out
}

fn write_state(
    root: &Path,
    relative: &str,
    state: FileState,
    mode: Option<u32>,
) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    if path_contains_symlink(root, &relative) {
        return Err(format!("Cannot write through symbolic link {relative}"));
    }
    match state {
        FileState::Contents(bytes) => {
            let path = root.join(relative);
            write_worktree(&path, &bytes)?;
            set_file_mode(&path, mode)
        }
        FileState::Missing => remove_worktree(root, &relative),
        FileState::Skipped => Err(format!("Cannot write unsupported file {relative}")),
    }
}

fn stored_snapshot(
    dir: &Path,
    relative: &str,
    kind: SnapshotKind,
    after: bool,
) -> (FileState, Option<u32>) {
    let blob_root = if after {
        dir.join("after")
    } else {
        dir.join("files")
    };
    (
        read_snapshot_at(&blob_root, relative, kind),
        snapshot_mode(&blob_root, relative, kind),
    )
}

fn worktree_snapshot(root: &Path, relative: &str) -> (FileState, Option<u32>) {
    (
        read_worktree(root, relative),
        file_mode(&root.join(relative)),
    )
}

fn path_contains_symlink(root: &Path, relative: &str) -> bool {
    let mut current = root.to_path_buf();
    for part in relative.split('/') {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        }
    }
    false
}

fn git_head(root: &Path) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    let output = command
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn diff_from_manifest(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    foreign_touched: &HashSet<String>,
) -> CheckpointStatus {
    diff_from_manifest_with(
        &git_diff_files_for(root),
        dir,
        root,
        manifest,
        foreign_touched,
    )
}

fn diff_from_manifest_with(
    index: &GitDiffIndex,
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    foreign_touched: &HashSet<String>,
) -> CheckpointStatus {
    let by_relative: BTreeMap<&str, &GitChangedFile> = index
        .files
        .iter()
        .map(|file| (file.relative.as_str(), file))
        .collect();
    let git_dirty: HashSet<&str> = by_relative.keys().copied().collect();
    let mut files = Vec::new();

    for relative in &manifest.touched {
        // Without a tool-start snapshot there is no trustworthy session
        // boundary. Never guess from the shared working tree.
        if !manifest.prepared.contains(relative) {
            continue;
        }
        if session_snapshot_differs(dir, manifest, relative) == Some(false) {
            continue;
        }
        if !file_differs(dir, root, manifest, relative, &git_dirty) {
            continue;
        }
        // Review is always scoped to this session's captured before/after
        // snapshots. A foreign claim can make restoring the file unsafe, but
        // it does not make this session's recorded diff or counts inexact.
        let exact = !manifest.diverged.contains(relative);
        let undoable = exact
            && !foreign_touched.contains(relative)
            && after_matches_worktree(dir, root, manifest, relative);
        let session_change = manifest.stats.get(relative).map(|stats| {
            let additions = if exact { stats.additions } else { 0 };
            let deletions = if exact { stats.deletions } else { 0 };
            (stats.status.clone(), additions, deletions)
        });
        files.push(describe_change(
            root,
            relative,
            by_relative.get(relative.as_str()).copied(),
            exact,
            undoable,
            session_change,
        ));
    }

    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    CheckpointStatus { files }
}

fn session_snapshot_differs(dir: &Path, manifest: &Manifest, relative: &str) -> Option<bool> {
    let before = manifest.files.get(relative).copied()?;
    let after = manifest.after.get(relative).copied()?;
    Some(read_snapshot(dir, relative, before) != read_after_snapshot(dir, relative, after))
}

#[cfg(test)]
fn stats_from_status(status: &CheckpointStatus) -> GitDiffStats {
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for file in &status.files {
        additions += file.additions;
        deletions += file.deletions;
    }
    GitDiffStats {
        files: status.files.len() as i64,
        additions,
        deletions,
    }
}

fn file_differs(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    relative: &str,
    git_dirty: &HashSet<&str>,
) -> bool {
    // Once a tracked path is clean against HEAD, its session change was
    // committed (or otherwise resolved) and no longer needs review.
    if !git_dirty.contains(relative)
        && (manifest.tracked.contains(relative) || in_head(root, relative))
    {
        return false;
    }
    match manifest.files.get(relative) {
        Some(SnapshotKind::Skipped) => false,
        Some(kind) => read_worktree(root, relative) != read_snapshot(dir, relative, *kind),
        None => {
            git_dirty.contains(relative)
                || (root.join(relative).is_file() && !in_head(root, relative))
        }
    }
}

fn describe_change(
    root: &Path,
    relative: &str,
    git: Option<&GitChangedFile>,
    exact: bool,
    undoable: bool,
    session_change: Option<(String, i64, i64)>,
) -> CheckpointFile {
    if let Some((status, additions, deletions)) = session_change {
        return CheckpointFile {
            path: path_to_js(&root.join(relative)),
            relative: relative.to_string(),
            status,
            additions,
            deletions,
            exact,
            undoable,
        };
    }
    if let Some(file) = git {
        return CheckpointFile {
            path: file.path.clone(),
            relative: file.relative.clone(),
            status: file.status.clone(),
            additions: file.additions,
            deletions: file.deletions,
            exact,
            undoable,
        };
    }
    let abs = root.join(relative);
    let status = if !abs.exists() { "deleted" } else { "modified" };
    CheckpointFile {
        path: path_to_js(&abs),
        relative: relative.to_string(),
        status: status.into(),
        additions: 0,
        deletions: 0,
        exact,
        undoable,
    }
}

fn calculate_session_stats(dir: &Path, manifest: &Manifest, relative: &str) -> Option<ChangeStats> {
    let before = manifest.files.get(relative).copied()?;
    let after = manifest.after.get(relative).copied()?;
    if before == SnapshotKind::Skipped || after == SnapshotKind::Skipped {
        return None;
    }
    let before_path = state_blob_path(&dir.join("files"), relative).ok()?;
    let after_path = state_blob_path(&dir.join("after"), relative).ok()?;
    let (additions, deletions) = diff_numstat(&before_path, &after_path)?;
    let status = match (before, after) {
        (SnapshotKind::Missing, SnapshotKind::Missing) => "modified",
        (SnapshotKind::Missing, _) => "added",
        (_, SnapshotKind::Missing) => "deleted",
        _ => "modified",
    };
    Some(ChangeStats {
        status: status.into(),
        additions,
        deletions,
    })
}

fn diff_numstat(before: &Path, after: &Path) -> Option<(i64, i64)> {
    let mut cmd = Command::new("git");
    crate::hide_window_console(&mut cmd);
    let output = cmd
        .args(["diff", "--no-index", "--no-ext-diff", "--numstat", "--"])
        .arg(before)
        .arg(after)
        .output()
        .ok()?;
    if !output.status.success() && output.status.code() != Some(1) {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.lines().next()?.split('\t');
    let additions = fields.next()?.parse().ok()?;
    let deletions = fields.next()?.parse().ok()?;
    Some((additions, deletions))
}

fn after_matches_worktree(dir: &Path, root: &Path, manifest: &Manifest, relative: &str) -> bool {
    let Some(kind) = manifest.after.get(relative).copied() else {
        return false;
    };
    read_worktree(root, relative) == read_after_snapshot(dir, relative, kind)
}

fn release_path(manifest: &mut Manifest, relative: &str) {
    manifest.files.remove(relative);
    manifest.touched.remove(relative);
    manifest.tracked.remove(relative);
    manifest.prepared.remove(relative);
    manifest.after.remove(relative);
    manifest.stats.remove(relative);
    manifest.diverged.remove(relative);
}

fn restore_one(dir: &Path, root: &Path, manifest: &Manifest, relative: &str) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    match manifest.files.get(&relative) {
        Some(SnapshotKind::Skipped) => Ok(()),
        Some(kind) => restore_snapshot(dir, root, &relative, *kind),
        None => revert_new_change(root, &relative),
    }
}

fn restore_snapshot(
    dir: &Path,
    root: &Path,
    relative: &str,
    kind: SnapshotKind,
) -> Result<(), String> {
    match kind {
        SnapshotKind::Skipped => Ok(()),
        SnapshotKind::Missing => {
            let _ = git_checked(root, &["reset", "-q", "HEAD", "--", relative]);
            remove_worktree(root, relative)
        }
        SnapshotKind::Contents => {
            let bytes = match read_snapshot(dir, relative, kind) {
                FileState::Contents(bytes) => bytes,
                _ => return Ok(()),
            };
            write_worktree(&root.join(relative), &bytes)?;
            let _ = git_checked(root, &["reset", "-q", "HEAD", "--", relative]);
            Ok(())
        }
    }
}

fn revert_new_change(root: &Path, relative: &str) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    if in_head(root, &relative) {
        return git_checked(
            root,
            &[
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                &relative,
            ],
        );
    }
    let _ = git_checked(root, &["reset", "-q", "HEAD", "--", &relative]);
    remove_worktree(root, &relative)
}

fn in_head(root: &Path, relative: &str) -> bool {
    git_checked(root, &["cat-file", "-e", &format!("HEAD:{relative}")]).is_ok()
}

fn snapshot_file(dir: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    snapshot_file_at(&dir.join("files"), root, relative)
}

fn snapshot_after_file(dir: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    snapshot_file_at(&dir.join("after"), root, relative)
}

/// Snapshot what a fresh checkout of HEAD holds at `relative`, after the
/// smudge and line-ending filters the checkout applies. An isolated worker
/// started from exactly this for every path that was clean at its first turn.
fn snapshot_checkout_file(dir: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    let blob = state_blob_path(&dir.join("files"), relative)?;
    if let Some(parent) = blob.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let unreadable = || format!("Could not read {relative} from HEAD");
    let listing = git_stdout(
        root,
        &[
            "--literal-pathspecs",
            "ls-tree",
            "-l",
            "-z",
            "HEAD",
            "--",
            relative,
        ],
    )
    .ok_or_else(unreadable)?;
    // Each record is "<mode> <type> <object> <size>\t<path>".
    let entry = listing.split(|byte| *byte == 0).find_map(|record| {
        let tab = record.iter().position(|byte| *byte == b'\t')?;
        (&record[tab + 1..] == relative.as_bytes())
            .then(|| String::from_utf8_lossy(&record[..tab]).into_owned())
    });
    let Some(entry) = entry else {
        std::fs::write(&blob, []).map_err(|e| e.to_string())?;
        return Ok(SnapshotKind::Missing);
    };
    let fields: Vec<&str> = entry.split_whitespace().collect();
    let [mode, kind, _, size] = fields[..] else {
        return Ok(SnapshotKind::Skipped);
    };
    if kind != "blob"
        || mode == "120000"
        || size
            .parse::<u64>()
            .map_or(true, |size| size > MAX_TEXT_FILE_BYTES)
    {
        return Ok(SnapshotKind::Skipped);
    }
    let bytes = git_stdout(
        root,
        &["cat-file", "--filters", &format!("HEAD:{relative}")],
    )
    .ok_or_else(unreadable)?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Ok(SnapshotKind::Skipped);
    }
    std::fs::write(&blob, bytes).map_err(|e| e.to_string())?;
    set_file_mode(&blob, checkout_mode(mode))?;
    Ok(SnapshotKind::Contents)
}

fn git_stdout(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    let output = command
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

#[cfg(unix)]
fn checkout_mode(git_mode: &str) -> Option<u32> {
    Some(if git_mode == "100755" { 0o755 } else { 0o644 })
}

#[cfg(not(unix))]
fn checkout_mode(_git_mode: &str) -> Option<u32> {
    None
}

fn snapshot_file_at(blob_root: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    let abs = root.join(relative);
    let meta = match std::fs::symlink_metadata(&abs) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let blob = state_blob_path(blob_root, relative)?;
            if let Some(parent) = blob.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(blob, []).map_err(|e| e.to_string())?;
            return Ok(SnapshotKind::Missing);
        }
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(SnapshotKind::Skipped);
    }
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Ok(SnapshotKind::Skipped);
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    let blob = state_blob_path(blob_root, relative)?;
    if let Some(parent) = blob.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&blob, bytes).map_err(|e| e.to_string())?;
    set_file_mode(&blob, file_mode(&abs))?;
    Ok(SnapshotKind::Contents)
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file() && !meta.file_type().is_symlink())
        .map(|meta| meta.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_file_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

fn snapshot_mode(blob_root: &Path, relative: &str, kind: SnapshotKind) -> Option<u32> {
    if kind != SnapshotKind::Contents {
        return None;
    }
    state_blob_path(blob_root, relative)
        .ok()
        .and_then(|path| file_mode(&path))
}

fn read_snapshot(dir: &Path, relative: &str, kind: SnapshotKind) -> FileState {
    read_snapshot_at(&dir.join("files"), relative, kind)
}

fn read_after_snapshot(dir: &Path, relative: &str, kind: SnapshotKind) -> FileState {
    read_snapshot_at(&dir.join("after"), relative, kind)
}

fn read_snapshot_at(blob_root: &Path, relative: &str, kind: SnapshotKind) -> FileState {
    match kind {
        SnapshotKind::Missing => FileState::Missing,
        SnapshotKind::Skipped => FileState::Skipped,
        SnapshotKind::Contents => match state_blob_path(blob_root, relative)
            .ok()
            .and_then(|path| std::fs::read(path).ok())
        {
            Some(bytes) => FileState::Contents(bytes),
            None => FileState::Missing,
        },
    }
}

fn read_worktree(root: &Path, relative: &str) -> FileState {
    let abs = root.join(relative);
    if !abs.exists() {
        return FileState::Missing;
    }
    if !abs.is_file() {
        return FileState::Skipped;
    }
    match std::fs::metadata(&abs).and_then(|meta| {
        if meta.len() > MAX_TEXT_FILE_BYTES {
            return Ok(FileState::Skipped);
        }
        std::fs::read(&abs).map(FileState::Contents)
    }) {
        Ok(state) => state,
        Err(_) => FileState::Missing,
    }
}

fn state_is_binary(state: &FileState) -> bool {
    matches!(state, FileState::Contents(bytes) if bytes.contains(&0))
}

fn state_text(state: FileState) -> String {
    match state {
        FileState::Contents(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        FileState::Missing | FileState::Skipped => String::new(),
    }
}

fn write_worktree(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.is_dir() {
        return Err(format!("{} is a directory", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

fn remove_worktree(root: &Path, relative: &str) -> Result<(), String> {
    let abs = root.join(relative);
    if abs.is_file() || abs.is_symlink() {
        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if abs.is_dir() {
        let _ = git_checked(root, &["clean", "-fd", "--", relative]);
        if abs.exists() {
            std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn state_blob_path(blob_root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "..")
    {
        return Err("Invalid path".into());
    }
    Ok(blob_root.join(relative))
}

fn read_manifest(dir: &Path) -> Result<Option<Manifest>, String> {
    let path = dir.join("manifest.json");
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join("manifest.json");
    let tmp = dir.join("manifest.json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dest).map_err(|e| e.to_string())
}

fn project_root(cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return Err("cwd is required".into());
    }
    let root = expand_home(trimmed);
    if !root.is_dir() {
        return Err(format!("{}: Not a directory", root.display()));
    }
    Ok(root)
}

fn same_cwd(saved: &str, cwd: &str) -> bool {
    let Ok(left) = project_root(saved) else {
        return false;
    };
    let Ok(right) = project_root(cwd) else {
        return false;
    };
    left == right
}

fn relative_to_root(root: &Path, path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Invalid path".into());
    }
    let expanded = expand_home(trimmed);
    if expanded.is_absolute() {
        let relative = expanded
            .strip_prefix(root)
            .map_err(|_| "Path is outside the project".to_string())?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        return resolve_repo_path(root, &relative);
    }
    resolve_repo_path(root, trimmed)
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("Invalid {label} id"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(label: &str) -> Tmp {
        loop {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "monocode-checkpoint-{label}-{}-{stamp}-{seq}",
                std::process::id()
            ));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Tmp(dir),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{}", error),
            }
        }
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "monocode")
            .env("GIT_AUTHOR_EMAIL", "monocode@test")
            .env("GIT_COMMITTER_NAME", "monocode")
            .env("GIT_COMMITTER_EMAIL", "monocode@test")
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn init_git_commit(dir: &Path, files: &[(&str, &str)]) -> bool {
        if !git(dir, &["init", "-b", "main"]) && !git(dir, &["init"]) {
            return false;
        }
        let _ = git(dir, &["config", "user.email", "monocode@test"]);
        let _ = git(dir, &["config", "user.name", "monocode"]);
        let _ = git(dir, &["config", "core.autocrlf", "false"]);
        for (name, contents) in files {
            let path = dir.join(name);
            if let Some(parent) = path.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    return false;
                }
            }
            if std::fs::write(&path, contents).is_err() {
                return false;
            }
        }
        git(dir, &["add", "."]) && git(dir, &["commit", "-m", "init"])
    }

    fn store() -> (Tmp, CheckpointStore) {
        let dir = tmp("store");
        let store = CheckpointStore::new(dir.0.clone());
        (dir, store)
    }

    fn relatives(status: &CheckpointStatus) -> Vec<&str> {
        status
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect()
    }

    fn record(store: &CheckpointStore, id: &str, cwd: &str, paths: &[&str]) {
        let owned: Vec<String> = paths.iter().map(|path| (*path).to_string()).collect();
        store.capture(id, cwd, &owned).unwrap();
        // Most legacy tests write before calling this helper. Mark their
        // already-captured baselines as if a tool-start prepare event ran;
        // dedicated tests below exercise the real prepare/capture lifecycle.
        let root = project_root(cwd).unwrap();
        let dir = store.session_dir(id);
        let mut manifest = read_manifest(&dir).unwrap().unwrap();
        for path in paths {
            manifest
                .prepared
                .insert(relative_to_root(&root, path).unwrap());
        }
        write_manifest(&dir, &manifest).unwrap();
    }

    #[test]
    fn undo_reverts_only_session_files_and_keeps_user_dirty() {
        let repo = tmp("keep-user");
        if !init_git_commit(&repo.0, &[("user.txt", "mine\n"), ("clean.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("user.txt"), "mine-dirty\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd, false).unwrap();

        std::fs::write(repo.0.join("user.txt"), "agent-on-user\n").unwrap();
        std::fs::write(repo.0.join("clean.txt"), "agent-on-clean\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), "created\n").unwrap();
        record(&store, "s1", &cwd, &["user.txt", "clean.txt", "new.txt"]);

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["clean.txt", "new.txt", "user.txt"]);

        store.undo("s1", &cwd, None).unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.0.join("user.txt")).unwrap(),
            "mine-dirty\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("clean.txt")).unwrap(),
            "head\n"
        );
        assert!(!repo.0.join("new.txt").exists());
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn undo_does_not_touch_untouched_user_files() {
        let repo = tmp("untouched");
        if !init_git_commit(&repo.0, &[("keep.txt", "head\n"), ("edit.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("keep.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();

        std::fs::write(repo.0.join("edit.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("created.txt"), "new\n").unwrap();
        record(&store, "s1", &cwd, &["edit.txt", "created.txt"]);

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["created.txt", "edit.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("keep.txt")).unwrap(),
            "user\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("edit.txt")).unwrap(),
            "head\n"
        );
        assert!(!repo.0.join("created.txt").exists());
    }

    #[test]
    fn ensure_is_idempotent_across_turns() {
        let repo = tmp("idempotent");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("a.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent-1\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);
        store.ensure("s1", &cwd, false).unwrap();
        std::fs::write(repo.0.join("b.txt"), "agent-2\n").unwrap();
        record(&store, "s1", &cwd, &["b.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "user\n"
        );
        assert!(!repo.0.join("b.txt").exists());
    }

    #[test]
    fn keep_clears_review_and_leaves_files() {
        let repo = tmp("keep");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "new\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt", "b.txt"]);
        assert!(!store.status("s1", &cwd).unwrap().files.is_empty());

        store.keep("s1", &cwd, None).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("b.txt")).unwrap(),
            "new\n"
        );
    }

    #[test]
    fn keep_one_file_then_undo_the_rest() {
        let repo = tmp("keep-one");
        if !init_git_commit(&repo.0, &[("a.txt", "head-a\n"), ("b.txt", "head-b\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent-a\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "agent-b\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt", "b.txt"]);

        store.keep("s1", &cwd, Some("a.txt")).unwrap();
        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["b.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent-a\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("b.txt")).unwrap(),
            "head-b\n"
        );
    }

    #[test]
    fn ensure_baselines_other_session_dirty_files() {
        let repo = tmp("ensure-baseline");
        if !init_git_commit(&repo.0, &[("plan.md", "old\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd, false).unwrap();
        std::fs::write(repo.0.join("plan.md"), "session-one\n").unwrap();
        record(&store, "s1", &cwd, &["plan.md"]);

        store.ensure("s2", &cwd, false).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn other_session_edits_do_not_appear_in_review() {
        let repo = tmp("two-sessions");
        if !init_git_commit(&repo.0, &[("plan.md", "old\n"), ("readme.md", "old\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd, false).unwrap();
        std::fs::write(repo.0.join("plan.md"), "session-one\n").unwrap();
        record(&store, "s1", &cwd, &["plan.md"]);
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["plan.md"]
        );

        store.ensure("s2", &cwd, false).unwrap();
        std::fs::write(repo.0.join("readme.md"), "session-two\n").unwrap();
        record(&store, "s2", &cwd, &["readme.md"]);

        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["plan.md"]
        );
        assert_eq!(
            relatives(&store.status("s2", &cwd).unwrap()),
            vec!["readme.md"]
        );

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("plan.md")).unwrap(),
            "old\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("readme.md")).unwrap(),
            "session-two\n"
        );
    }

    #[test]
    fn read_only_session_has_no_changes_when_another_session_edits() {
        let repo = tmp("read-only-session");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("writer", &cwd, false).unwrap();
        store.ensure("reader", &cwd, false).unwrap();

        store.prepare("writer", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "writer\n").unwrap();
        store.capture("writer", &cwd, &["app.ts".into()]).unwrap();

        assert_eq!(
            relatives(&store.status("writer", &cwd).unwrap()),
            vec!["app.ts"]
        );
        assert!(store.status("reader", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn status_counts_only_the_session_delta_from_its_pre_edit_snapshot() {
        let repo = tmp("session-counts");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\nagent\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].additions, 1);
        assert_eq!(status.files[0].deletions, 0);
        assert!(status.files[0].exact);
        assert!(status.files[0].undoable);
        assert_eq!(status.files[0].path, path_to_js(&repo.0.join("app.ts")));

        let diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(diff.original, "user-one\nuser-two\n");
        assert_eq!(diff.current, "user-one\nuser-two\nagent\n");
        assert_eq!(diff.path, path_to_js(&repo.0.join("app.ts")));

        // Review remains the captured session result, not a later shared
        // working-tree state.
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\nagent\nother\n").unwrap();
        let diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(diff.current, "user-one\nuser-two\nagent\n");
    }

    #[test]
    fn shared_file_keeps_session_scoped_review_but_disables_unsafe_undo() {
        let repo = tmp("shared-file");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        store.ensure("s2", &cwd, false).unwrap();

        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "session-one\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        store.prepare("s2", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "session-one\nsession-two\n").unwrap();
        store.capture("s2", &cwd, &["app.ts".into()]).unwrap();

        let s1 = store.status("s1", &cwd).unwrap();
        let s2 = store.status("s2", &cwd).unwrap();
        assert!(s1.files[0].exact);
        assert!(s2.files[0].exact);
        assert_eq!((s1.files[0].additions, s1.files[0].deletions), (1, 1));
        assert_eq!((s2.files[0].additions, s2.files[0].deletions), (1, 0));
        assert!(!s1.files[0].undoable);
        assert!(!s2.files[0].undoable);
        let s1_diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(s1_diff.original, "head\n");
        assert_eq!(s1_diff.current, "session-one\n");
        let s2_diff = store.file_diff("s2", &cwd, "app.ts").unwrap();
        assert_eq!(s2_diff.original, "session-one\n");
        assert_eq!(s2_diff.current, "session-one\nsession-two\n");
        assert!(store.undo("s1", &cwd, None).is_err());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "session-one\nsession-two\n"
        );

        // Accepting s1 releases its ownership without touching the file. The
        // second session can then safely undo back to the contents it started
        // from, preserving s1's accepted line.
        store.keep("s1", &cwd, None).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files[0].undoable);
        store.undo("s2", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "session-one\n"
        );
    }

    #[test]
    fn undo_refuses_a_file_changed_after_the_session_edit() {
        let repo = tmp("changed-after");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "agent\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        std::fs::write(repo.0.join("app.ts"), "agent\nother\n").unwrap();

        assert!(!store.status("s1", &cwd).unwrap().files[0].undoable);
        assert!(store.undo("s1", &cwd, None).is_err());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "agent\nother\n"
        );
    }

    #[test]
    fn capture_missing_path_lets_non_git_undo_delete() {
        let project = tmp("nongit");
        let cwd = project.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        store
            .prepare(
                "s1",
                &cwd,
                &[project.0.join("made.txt").to_string_lossy().into_owned()],
            )
            .unwrap();
        std::fs::write(project.0.join("made.txt"), "hello\n").unwrap();
        store
            .capture(
                "s1",
                &cwd,
                &[project.0.join("made.txt").to_string_lossy().into_owned()],
            )
            .unwrap();
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["made.txt"]
        );
        store.undo("s1", &cwd, None).unwrap();
        assert!(!project.0.join("made.txt").exists());
    }

    #[test]
    fn late_capture_is_not_attributed_to_the_session() {
        let repo = tmp("late-capture");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent\n").unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );

        // A later structured edit in that same session replaces the
        // untrusted completion-only claim with a real boundary.
        store.ensure("s1", &cwd, false).unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        store.prepare("s1", &cwd, &["a.txt".into()]).unwrap();
        std::fs::write(repo.0.join("a.txt"), "same-session-valid\n").unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files[0].undoable);
        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );

        // An old/unprepared claim is not ownership and must not block a later
        // session that recorded a trustworthy before/after pair.
        store.ensure("s2", &cwd, false).unwrap();
        store.prepare("s2", &cwd, &["a.txt".into()]).unwrap();
        std::fs::write(repo.0.join("a.txt"), "second-session\n").unwrap();
        store.capture("s2", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files[0].undoable);
        store.undo("s2", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );
    }

    #[test]
    fn committed_session_changes_leave_review() {
        let repo = tmp("committed");
        if !init_git_commit(&repo.0, &[("edit.txt", "head\n"), ("delete.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();

        std::fs::write(repo.0.join("edit.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("created.txt"), "new\n").unwrap();
        std::fs::remove_file(repo.0.join("delete.txt")).unwrap();
        record(
            &store,
            "s1",
            &cwd,
            &["edit.txt", "created.txt", "delete.txt"],
        );
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["created.txt", "delete.txt", "edit.txt"]
        );

        assert!(git(&repo.0, &["add", "-A"]));
        assert!(git(&repo.0, &["commit", "-m", "agent changes"]));
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn deleting_untracked_baseline_still_needs_review() {
        let repo = tmp("delete-untracked");
        if !init_git_commit(&repo.0, &[("tracked.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("loose.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();

        std::fs::remove_file(repo.0.join("loose.txt")).unwrap();
        record(&store, "s1", &cwd, &["loose.txt"]);
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["loose.txt"]
        );
    }

    #[test]
    fn session_stats_match_git_not_edit_churn() {
        let repo = tmp("stats-churn");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();

        std::fs::write(repo.0.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);
        std::fs::write(repo.0.join("a.txt"), "head\nworld\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);

        let stats = store.stats_for_sessions(&cwd, &["s1".into()]).unwrap();
        let s1 = stats.get("s1").expect("s1 stats");
        assert_eq!(s1.files, 1);
        assert_eq!(s1.additions, 1);
        assert_eq!(s1.deletions, 0);
    }

    #[test]
    fn session_stats_are_scoped_to_touched_files() {
        let repo = tmp("stats-scoped");
        if !init_git_commit(&repo.0, &[("a.txt", "a\n"), ("b.txt", "b\n")]) {
            return;
        }
        std::fs::write(repo.0.join("b.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd, false).unwrap();

        std::fs::write(repo.0.join("a.txt"), "a\nA\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);

        let stats = store.stats_for_sessions(&cwd, &["s1".into()]).unwrap();
        let s1 = stats.get("s1").expect("s1 stats");
        assert_eq!(s1.files, 1);
        assert_eq!(s1.additions, 1);
        assert_eq!(s1.deletions, 0);
        assert_eq!(relatives(&store.status("s1", &cwd).unwrap()), vec!["a.txt"]);
    }

    #[test]
    fn isolated_worker_delta_applies_idempotently_to_matching_baseline() {
        let source = tmp("apply-source");
        let target = tmp("apply-target");
        if !init_git_commit(&source.0, &[("a.txt", "head\n")]) {
            return;
        }
        let source_path = source.0.to_string_lossy().into_owned();
        let target_path = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &source_path, &target_path]) {
            return;
        }
        std::fs::write(source.0.join("a.txt"), "user baseline\n").unwrap();
        std::fs::write(target.0.join("a.txt"), "user baseline\n").unwrap();
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("worker", &from, true).unwrap();
        assert!(store.cleanup_safe("worker", &from).unwrap());
        store.prepare("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(source.0.join("a.txt"), "worker result\n").unwrap();
        store.capture("worker", &from, &["a.txt".into()]).unwrap();
        assert!(!store.cleanup_safe("worker", &from).unwrap());

        let applied = store
            .apply("worker", &from, &to, &["a.txt".into()])
            .unwrap();
        assert_eq!(applied.files, ["a.txt"]);
        assert_eq!(applied.already_applied, 0);
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            "worker result\n"
        );
        let retried = store
            .apply("worker", &from, &to, &["a.txt".into()])
            .unwrap();
        assert_eq!(retried.already_applied, 1);
    }

    #[test]
    fn isolated_worker_integrates_a_new_untracked_file() {
        let source = tmp("apply-new-source");
        let target = tmp("apply-new-target");
        if !init_git_commit(&source.0, &[("a.txt", "head\n")]) {
            return;
        }
        let source_path = source.0.to_string_lossy().into_owned();
        let target_path = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &source_path, &target_path]) {
            return;
        }
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("worker", &from, true).unwrap();
        store
            .prepare("worker", &from, &["smoke/marker.txt".into()])
            .unwrap();
        std::fs::create_dir_all(source.0.join("smoke")).unwrap();
        std::fs::write(source.0.join("smoke/marker.txt"), "marker\n").unwrap();
        store
            .capture("worker", &from, &["smoke/marker.txt".into()])
            .unwrap();

        let applied = store
            .apply("worker", &from, &to, &["smoke".into()])
            .unwrap();
        assert_eq!(applied.files, ["smoke/marker.txt"]);
        assert_eq!(
            std::fs::read_to_string(target.0.join("smoke/marker.txt")).unwrap(),
            "marker\n"
        );
    }

    #[test]
    fn isolated_worker_integration_keeps_both_sides_on_conflict_or_unknown_edit() {
        let source = tmp("apply-conflict-source");
        let target = tmp("apply-conflict-target");
        if !init_git_commit(&source.0, &[("a.txt", "head\n")]) {
            return;
        }
        let source_path = source.0.to_string_lossy().into_owned();
        let target_path = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &source_path, &target_path]) {
            return;
        }
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        store.prepare("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(source.0.join("a.txt"), "worker\n").unwrap();
        store.capture("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(target.0.join("a.txt"), "lead changed\n").unwrap();

        let conflict = store
            .apply("worker", &from, &to, &["a.txt".into()])
            .unwrap_err();
        assert!(conflict.contains("lead checkout changed"));
        assert_eq!(
            std::fs::read_to_string(source.0.join("a.txt")).unwrap(),
            "worker\n"
        );
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            "lead changed\n"
        );

        std::fs::write(source.0.join("unreported.txt"), "unknown\n").unwrap();
        assert!(!store.cleanup_safe("worker", &from).unwrap());
        assert!(store
            .apply("worker", &from, &to, &["a.txt".into()])
            .unwrap_err()
            .contains("not captured"));
    }

    /// An isolated worker checkout and the lead checkout it integrates into,
    /// both at one commit and holding exactly `files`.
    fn worker_and_lead(label: &str, files: &[(&str, &str)]) -> Option<(Tmp, Tmp)> {
        let worker = tmp(&format!("{label}-worker"));
        let lead = tmp(&format!("{label}-lead"));
        if !init_git_commit(&worker.0, files) {
            return None;
        }
        let worker_path = worker.0.to_string_lossy().into_owned();
        let lead_path = lead.0.to_string_lossy().into_owned();
        if !git(&worker.0, &["clone", "-q", &worker_path, &lead_path]) {
            return None;
        }
        // A system-wide autocrlf may have converted the clone's checkout.
        let _ = git(&lead.0, &["config", "core.autocrlf", "false"]);
        for (name, contents) in files {
            std::fs::write(lead.0.join(name), contents).unwrap();
        }
        if !git(&lead.0, &["add", "-A"]) {
            return None;
        }
        Some((worker, lead))
    }

    fn cwd_of(dir: &Tmp) -> String {
        dir.0.to_string_lossy().into_owned()
    }

    fn bytes(dir: &Tmp, relative: &str) -> Vec<u8> {
        std::fs::read(dir.0.join(relative)).unwrap()
    }

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    /// Both checkouts use `core.autocrlf=true`. The worker's fresh checkout
    /// converted `relative` to CRLF; the lead's older checkout kept LF. Git
    /// considers both clean.
    fn diverge_line_endings(worker: &Tmp, lead: &Tmp, relative: &str) {
        for dir in [worker, lead] {
            assert!(git(&dir.0, &["config", "core.autocrlf", "true"]));
        }
        std::fs::remove_file(worker.0.join(relative)).unwrap();
        assert!(git(&worker.0, &["checkout", "--", relative]));
        let lf = bytes(lead, relative);
        assert!(!lf.contains(&b'\r'));
        let crlf = String::from_utf8(lf).unwrap().replace('\n', "\r\n");
        assert_eq!(bytes(worker, relative), crlf.into_bytes());
        assert_eq!(git_out(&worker.0, &["status", "--porcelain"]), "");
        assert_eq!(git_out(&lead.0, &["status", "--porcelain"]), "");
    }

    #[test]
    fn turn_end_capture_integrates_shell_edits_after_the_last_tool_edit() {
        let Some((worker, lead)) = worker_and_lead("shell-after", &[("README.md", "head\n")])
        else {
            return;
        };
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["context/audit.md"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::create_dir_all(worker.0.join("context")).unwrap();
        std::fs::write(worker.0.join("context/audit.md"), "draft\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();
        // Codex finishes the report through shell commands, which report no
        // tool event. The result has mixed line endings.
        std::fs::write(worker.0.join("context/audit.md"), "final\r\nmixed\n").unwrap();

        store.reconcile("worker", &from, &scope).unwrap();
        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["context/audit.md"]);
        assert_eq!(bytes(&lead, "context/audit.md"), b"final\r\nmixed\n");
    }

    #[test]
    fn turn_end_capture_integrates_files_changed_only_through_the_shell() {
        let Some((worker, lead)) = worker_and_lead(
            "shell-only",
            &[("README.md", "head\n"), ("docs/old.md", "old\n")],
        ) else {
            return;
        };
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["README.md", "docs"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        std::fs::write(worker.0.join("README.md"), "edited\n").unwrap();
        std::fs::write(worker.0.join("docs/new.md"), "new\n").unwrap();
        std::fs::remove_file(worker.0.join("docs/old.md")).unwrap();

        store.reconcile("worker", &from, &scope).unwrap();
        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["README.md", "docs/new.md", "docs/old.md"]);
        assert_eq!(bytes(&lead, "README.md"), b"edited\n");
        assert_eq!(bytes(&lead, "docs/new.md"), b"new\n");
        assert!(!lead.0.join("docs/old.md").exists());
        // The worker's review shows the whole turn, not just tool edits.
        let status = store.status("worker", &from).unwrap();
        assert_eq!(
            relatives(&status),
            vec!["README.md", "docs/new.md", "docs/old.md"]
        );
        assert!(status.files.iter().all(|file| file.exact));
    }

    #[test]
    fn isolated_baseline_survives_a_shell_edit_before_the_first_tool_edit() {
        let Some((worker, lead)) =
            worker_and_lead("baseline", &[("a.txt", "head\n"), ("b.txt", "head\n")])
        else {
            return;
        };
        // Uncommitted lead work is seeded into the worker checkout.
        std::fs::write(lead.0.join("a.txt"), "lead draft\n").unwrap();
        std::fs::write(worker.0.join("a.txt"), "lead draft\n").unwrap();
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["a.txt", "b.txt"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        // The worker edits both files through the shell before its first
        // structured edit, so a tool-start snapshot is not the baseline.
        std::fs::write(worker.0.join("a.txt"), "lead draft\nshell\n").unwrap();
        std::fs::write(worker.0.join("b.txt"), "shell\n").unwrap();
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("a.txt"), "lead draft\nshell\ntool\n").unwrap();
        std::fs::write(worker.0.join("b.txt"), "shell\ntool\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();

        store.reconcile("worker", &from, &scope).unwrap();
        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["a.txt", "b.txt"]);
        assert_eq!(bytes(&lead, "a.txt"), b"lead draft\nshell\ntool\n");
        assert_eq!(bytes(&lead, "b.txt"), b"shell\ntool\n");
    }

    #[test]
    fn tool_edit_after_a_shell_edit_does_not_strand_an_isolated_worker() {
        let Some((worker, lead)) = worker_and_lead("no-diverge", &[("README.md", "head\n")]) else {
            return;
        };
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["report.md"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("report.md"), "v1\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("report.md"), "v2 through the shell\n").unwrap();
        // A later apply_patch on the same file.
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("report.md"), "v3\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();

        store.reconcile("worker", &from, &scope).unwrap();
        assert!(store.status("worker", &from).unwrap().files[0].exact);
        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["report.md"]);
        assert_eq!(bytes(&lead, "report.md"), b"v3\n");
    }

    #[test]
    fn turn_end_capture_clears_divergence_left_by_an_older_worker_checkpoint() {
        let Some((worker, lead)) = worker_and_lead("legacy-diverge", &[("README.md", "head\n")])
        else {
            return;
        };
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["report.md"]);
        let (_root, store) = store();
        // Checkpoints written before isolated checkouts were marked.
        store.ensure("worker", &from, false).unwrap();
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("report.md"), "v1\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("report.md"), "v2 through the shell\n").unwrap();
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("report.md"), "v3\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();
        assert!(store
            .apply("worker", &from, &to, &scope)
            .unwrap_err()
            .contains("changed outside the worker"));

        // The next turn end re-captures the whole checkout.
        store.reconcile("worker", &from, &scope).unwrap();
        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["report.md"]);
        assert_eq!(bytes(&lead, "report.md"), b"v3\n");
    }

    #[test]
    fn turn_end_capture_never_claims_writes_outside_the_task_scope() {
        let Some((worker, lead)) =
            worker_and_lead("scope", &[("docs/a.md", "a\n"), ("src/b.ts", "b\n")])
        else {
            return;
        };
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["docs"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        std::fs::write(worker.0.join("docs/a.md"), "a2\n").unwrap();
        std::fs::write(worker.0.join("src/b.ts"), "stray\n").unwrap();
        std::fs::write(worker.0.join("src/new.ts"), "stray\n").unwrap();
        std::fs::write(worker.0.join("docsx.md"), "stray\n").unwrap();

        store.reconcile("worker", &from, &scope).unwrap();
        assert!(store
            .apply("worker", &from, &to, &scope)
            .unwrap_err()
            .contains("not captured"));
        assert_eq!(bytes(&lead, "docs/a.md"), b"a\n");
        assert!(!lead.0.join("src/new.ts").exists());

        // Once the worker reverts its stray writes, its in-scope work integrates.
        std::fs::write(worker.0.join("src/b.ts"), "b\n").unwrap();
        std::fs::remove_file(worker.0.join("src/new.ts")).unwrap();
        std::fs::remove_file(worker.0.join("docsx.md")).unwrap();
        store.reconcile("worker", &from, &scope).unwrap();
        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["docs/a.md"]);
        assert_eq!(bytes(&lead, "src/b.ts"), b"b\n");
    }

    #[test]
    fn integration_rejects_a_captured_change_outside_the_task_scope() {
        let Some((worker, lead)) =
            worker_and_lead("apply-scope", &[("docs/a.md", "a\n"), ("src/b.ts", "b\n")])
        else {
            return;
        };
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        store
            .prepare("worker", &from, &paths(&["src/b.ts"]))
            .unwrap();
        std::fs::write(worker.0.join("src/b.ts"), "stray\n").unwrap();
        store
            .capture("worker", &from, &paths(&["src/b.ts"]))
            .unwrap();

        let error = store
            .apply("worker", &from, &to, &paths(&["docs"]))
            .unwrap_err();
        assert!(error.contains("outside this task's write scope"), "{error}");
        assert_eq!(bytes(&lead, "src/b.ts"), b"b\n");
    }

    #[test]
    fn integration_ignores_line_ending_only_differences_in_the_lead_checkout() {
        let Some((worker, lead)) = worker_and_lead("eol", &[("app.ts", "one\ntwo\n")]) else {
            return;
        };
        diverge_line_endings(&worker, &lead, "app.ts");
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["app.ts"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("app.ts"), "one\r\ntwo\r\nthree\r\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();

        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["app.ts"]);
        // The lead keeps its own line endings, so only the real edit shows.
        assert_eq!(bytes(&lead, "app.ts"), b"one\ntwo\nthree\n");
        assert_eq!(
            git_out(&lead.0, &["diff", "--numstat"]).trim(),
            "1\t0\tapp.ts"
        );
        let retried = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(retried.already_applied, 1);
        assert_eq!(bytes(&lead, "app.ts"), b"one\ntwo\nthree\n");
    }

    #[test]
    fn integration_refuses_a_real_lead_change_behind_different_line_endings() {
        let Some((worker, lead)) = worker_and_lead("eol-conflict", &[("app.ts", "one\ntwo\n")])
        else {
            return;
        };
        diverge_line_endings(&worker, &lead, "app.ts");
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["app.ts"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        store.prepare("worker", &from, &scope).unwrap();
        std::fs::write(worker.0.join("app.ts"), "one\r\ntwo\r\nthree\r\n").unwrap();
        store.capture("worker", &from, &scope).unwrap();
        std::fs::write(lead.0.join("app.ts"), "one\nTWO\n").unwrap();

        assert!(store
            .apply("worker", &from, &to, &scope)
            .unwrap_err()
            .contains("lead checkout changed"));
        assert_eq!(bytes(&lead, "app.ts"), b"one\nTWO\n");
    }

    #[test]
    fn turn_end_capture_baselines_shell_edits_against_the_filtered_checkout() {
        let Some((worker, lead)) = worker_and_lead("eol-shell", &[("app.ts", "one\ntwo\n")]) else {
            return;
        };
        diverge_line_endings(&worker, &lead, "app.ts");
        let (from, to) = (cwd_of(&worker), cwd_of(&lead));
        let scope = paths(&["app.ts"]);
        let (_root, store) = store();
        store.ensure("worker", &from, true).unwrap();
        // Only a shell command edits the tracked file.
        std::fs::write(worker.0.join("app.ts"), "one\r\ntwo\r\nthree\r\n").unwrap();

        store.reconcile("worker", &from, &scope).unwrap();
        let diff = store.file_diff("worker", &from, "app.ts").unwrap();
        assert_eq!(diff.original, "one\r\ntwo\r\n");
        let applied = store.apply("worker", &from, &to, &scope).unwrap();
        assert_eq!(applied.files, ["app.ts"]);
        assert_eq!(bytes(&lead, "app.ts"), b"one\ntwo\nthree\n");
    }

    #[test]
    fn worker_results_follow_the_lead_only_across_a_pure_line_ending_difference() {
        let state = |bytes: &[u8]| (FileState::Contents(bytes.to_vec()), None);
        let convert = |before: &[u8], target: &[u8], after: &[u8]| match in_lead_line_endings(
            &state(before),
            &state(target),
            state(after),
        )
        .0
        {
            FileState::Contents(bytes) => bytes,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            convert(b"a\r\nb\r\n", b"a\nb\n", b"a\r\nb\r\nc\n"),
            b"a\nb\nc\n"
        );
        assert_eq!(
            convert(b"a\nb\n", b"a\r\nb\r\n", b"a\nb\nc\r\n"),
            b"a\r\nb\r\nc\r\n"
        );
        // Same bytes on both sides: the worker's own line endings stand.
        assert_eq!(convert(b"a\nb\n", b"a\nb\n", b"a\r\nb\r\n"), b"a\r\nb\r\n");
        assert_eq!(
            convert(b"a\r\n\0", b"a\n\0", b"a\r\nb\r\n\0"),
            b"a\r\nb\r\n\0"
        );
        assert_eq!(convert(b"a\r\nb\r\n", b"x\ny\n", b"c\r\n"), b"c\r\n");
    }

    #[test]
    fn write_scopes_match_at_path_boundaries() {
        let root = Path::new("/repo");
        let scopes = write_scopes(root, &paths(&["./src/", "docs\\guide.md"])).unwrap();
        assert!(in_write_scope(&scopes, "src/a.ts"));
        assert!(in_write_scope(&scopes, "src"));
        assert!(in_write_scope(&scopes, "docs/guide.md"));
        assert!(!in_write_scope(&scopes, "srcx/a.ts"));
        assert!(!in_write_scope(&scopes, "docs/guide.md.bak"));
        assert!(!in_write_scope(&scopes, "README.md"));
        let everything = write_scopes(root, &paths(&["."])).unwrap();
        assert!(in_write_scope(&everything, "any/file.txt"));
        assert!(write_scopes(root, &paths(&["../escape"])).is_err());
        assert!(!in_write_scope(
            &write_scopes(root, &[]).unwrap(),
            "src/a.ts"
        ));
    }

    #[test]
    fn rejects_invalid_session_id() {
        let err = validate_id("../x", "session").unwrap_err();
        assert!(err.contains("Invalid"));
    }
}
