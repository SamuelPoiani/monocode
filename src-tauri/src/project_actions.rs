use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, SyncSender};
use std::time::{Duration, Instant};

use serde::Serialize;

const MAX_OUTPUT: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActionResult {
    exit_code: Option<i32>,
    output: String,
    timed_out: bool,
}

#[tauri::command]
pub async fn run_project_action(
    cwd: String,
    command: String,
) -> Result<ProjectActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || run(&cwd, &command, TIMEOUT))
        .await
        .map_err(|error| error.to_string())?
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    let mut shell = {
        let mut shell = Command::new("cmd.exe");
        shell.args(["/D", "/C", command]);
        shell
    };
    #[cfg(not(windows))]
    let mut shell = {
        let path = std::env::var("SHELL")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| crate::passwd_identity().map(|identity| identity.shell))
            .unwrap_or_else(|| "/bin/sh".into());
        let mut shell = Command::new(path);
        shell.args(["-lc", command]);
        shell
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        shell.process_group(0);
    }
    crate::hide_window_console(&mut shell);
    shell
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    shell
}

fn read_output(mut pipe: impl Read + Send + 'static, sender: SyncSender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if sender.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

fn run(cwd: &str, command: &str, timeout: Duration) -> Result<ProjectActionResult, String> {
    if command.trim().is_empty() {
        return Err("Command is required".into());
    }
    let workdir = crate::fs::expand_home(cwd);
    let _reservation = crate::worktree_lifecycle::reserve_spawn(&workdir)?;
    let mut shell = shell_command(command);
    shell.current_dir(workdir);
    #[cfg(windows)]
    let mut child = crate::windows::spawn_managed(&mut shell);
    #[cfg(not(windows))]
    let mut child = shell.spawn();
    let child = child
        .as_mut()
        .map_err(|error| format!("Failed to start action: {error}"))?;
    let (sender, receiver) = mpsc::sync_channel(16);
    read_output(
        child.stdout.take().ok_or("Cannot read action stdout")?,
        sender.clone(),
    );
    read_output(
        child.stderr.take().ok_or("Cannot read action stderr")?,
        sender,
    );
    let started = Instant::now();
    let mut output = Vec::new();
    let mut truncated = false;
    let mut timed_out = false;
    let mut finished = None;
    let mut exit_code = None;
    loop {
        if finished.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    exit_code = status.code();
                    finished = Some(Instant::now());
                }
                Ok(None) if started.elapsed() >= timeout => {
                    terminate(child);
                    timed_out = true;
                    finished = Some(Instant::now());
                }
                Ok(None) => {}
                Err(error) => {
                    terminate(child);
                    return Err(format!("Cannot wait for action: {error}"));
                }
            }
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                let count = chunk.len().min(MAX_OUTPUT.saturating_sub(output.len()));
                output.extend_from_slice(&chunk[..count]);
                truncated |= count < chunk.len();
            }
            Err(mpsc::RecvTimeoutError::Disconnected) if finished.is_some() => break,
            Err(_) => {}
        }
        // Background descendants may retain the pipes after the shell exits.
        if finished.is_some_and(|at| at.elapsed() >= Duration::from_millis(200)) {
            break;
        }
    }
    let mut output = String::from_utf8_lossy(&output).into_owned();
    if truncated {
        output.push_str("\n[output truncated]");
    }
    if timed_out {
        output.push_str("\n[action timed out]");
    }
    Ok(ProjectActionResult {
        exit_code,
        output,
        timed_out,
    })
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        crate::hide_window_console(&mut kill);
        kill.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(mut killer) = kill.spawn() {
            let started = Instant::now();
            while matches!(killer.try_wait(), Ok(None))
                && started.elapsed() < Duration::from_secs(2)
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = killer.kill();
            let _ = killer.wait();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_both_streams_and_failure_status() {
        #[cfg(windows)]
        let command = "(echo stdout)&(echo stderr 1>&2)&exit /b 7";
        #[cfg(not(windows))]
        let command = "printf stdout; printf stderr >&2; exit 7";
        let result = run(std::env::temp_dir().to_str().unwrap(), command, TIMEOUT).unwrap();
        assert_eq!(result.exit_code, Some(7));
        assert!(result.output.contains("stdout"));
        assert!(result.output.contains("stderr"));
        assert!(!result.timed_out);
    }

    #[test]
    fn times_out_an_unfinished_command() {
        #[cfg(windows)]
        let command = "ping -n 10 127.0.0.1 >nul";
        #[cfg(not(windows))]
        let command = "sleep 10";
        let result = run(
            std::env::temp_dir().to_str().unwrap(),
            command,
            Duration::from_millis(50),
        )
        .unwrap();
        assert!(result.timed_out);
        assert!(result.output.contains("timed out"));
    }

    #[test]
    fn truncates_output_without_blocking_the_process() {
        #[cfg(windows)]
        let command = "for /L %i in (1,1,12000) do @echo 0123456789";
        #[cfg(not(windows))]
        let command = "i=0; while [ $i -lt 12000 ]; do echo 0123456789; i=$((i+1)); done";
        let result = run(std::env::temp_dir().to_str().unwrap(), command, TIMEOUT).unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output.ends_with("[output truncated]"));
        assert!(result.output.len() <= MAX_OUTPUT + 32);
    }
}
