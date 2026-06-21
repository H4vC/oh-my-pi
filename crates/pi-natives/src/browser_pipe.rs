use std::{
	collections::HashMap,
	sync::{Arc, Mutex},
	thread,
};

use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

#[napi(object)]
pub struct PatchrightPipeSpawnOptions {
	pub command:      String,
	pub args:         Vec<String>,
	pub cwd:          Option<String>,
	pub env:          Option<HashMap<String, String>>,
	pub windows_hide: Option<bool>,
}

#[napi(object)]
#[derive(Clone)]
pub struct PatchrightPipeExit {
	pub exit_code: Option<u32>,
}

fn validate_patchright_launch(options: &PatchrightPipeSpawnOptions) -> Result<()> {
	let command = options.command.to_ascii_lowercase();
	let exe_name = command
		.rsplit(['\\', '/'])
		.next()
		.unwrap_or(command.as_str());
	let looks_like_chromium = matches!(
		exe_name,
		"chrome.exe"
			| "chromium.exe"
			| "msedge.exe"
			| "headless_shell.exe"
			| "chrome"
			| "chromium"
			| "chromium-browser"
			| "google-chrome"
			| "google-chrome-stable"
			| "google-chrome-beta"
			| "google-chrome-canary"
			| "microsoft-edge"
			| "msedge"
			| "headless_shell"
			// macOS app-bundle executables (basename after the last /)
			| "google chrome"
			| "google chrome beta"
			| "google chrome canary"
			| "google chrome dev"
	) || command.contains("\\patchright\\")
		|| command.contains("/patchright/")
		|| command.contains("ms-playwright");
	if !looks_like_chromium
		|| !options
			.args
			.iter()
			.any(|arg| arg == "--remote-debugging-pipe")
	{
		return Err(Error::from_reason(
			"PatchrightPipeProcess only supports Patchright Chromium launches with \
			 --remote-debugging-pipe",
		));
	}
	Ok(())
}

#[cfg(target_os = "windows")]
mod platform {
	#![allow(
		clippy::undocumented_unsafe_blocks,
		reason = "Windows handle inheritance requires direct FFI; safety invariants live beside \
		          each wrapper"
	)]
	use std::{
		collections::HashMap,
		ffi::c_void,
		io,
		mem::{size_of, zeroed},
		ptr::{null, null_mut},
		sync::{Arc, Mutex},
	};

	use napi::bindgen_prelude::*;
	use windows_sys::Win32::{
		Foundation::{
			CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
		},
		Security::SECURITY_ATTRIBUTES,
		Storage::FileSystem::{
			CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
			OPEN_EXISTING, ReadFile, WriteFile,
		},
		System::{
			Pipes::CreatePipe,
			Threading::{
				CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
				DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
				InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
				PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
				STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
				WaitForSingleObject,
			},
		},
		UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWDEFAULT},
	};

	use super::{PatchrightPipeSpawnOptions, validate_patchright_launch};

	const FOPEN: u8 = 0x01;
	const FPIPE: u8 = 0x08;
	const FDEV: u8 = 0x40;
	const WAIT_OBJECT_0: u32 = 0;
	const INFINITE: u32 = 0xffff_ffff;
	const STILL_ACTIVE: u32 = 259;

	pub struct Inner {
		pub pid:         u32,
		pub process:     HANDLE,
		pub main_thread: HANDLE,
		pub cdp_write:   Mutex<Option<HANDLE>>,
	}

	impl Inner {
		pub fn write_cdp(&self, bytes: &[u8]) -> Result<()> {
			let guard = self
				.cdp_write
				.lock()
				.map_err(|_| Error::from_reason("cdp_write lock poisoned"))?;
			let handle = guard.ok_or_else(|| Error::from_reason("cdp_write is closed"))?;
			write_all(handle, bytes)
		}

		pub fn close_cdp(&self) -> Result<()> {
			let handle = self
				.cdp_write
				.lock()
				.map_err(|_| Error::from_reason("cdp_write lock poisoned"))?
				.take();
			if let Some(handle) = handle {
				unsafe { CloseHandle(handle) };
			}
			Ok(())
		}
	}

	unsafe impl Send for Inner {}
	unsafe impl Sync for Inner {}

	impl Drop for Inner {
		fn drop(&mut self) {
			if let Ok(mut writer) = self.cdp_write.lock()
				&& let Some(handle) = writer.take()
			{
				unsafe { CloseHandle(handle) };
			}
			unsafe {
				if !self.main_thread.is_null() && self.main_thread != INVALID_HANDLE_VALUE {
					CloseHandle(self.main_thread);
				}
				if !self.process.is_null() && self.process != INVALID_HANDLE_VALUE {
					CloseHandle(self.process);
				}
			}
		}
	}

	pub fn spawn(
		options: PatchrightPipeSpawnOptions,
	) -> Result<(Arc<Inner>, HANDLE, HANDLE, HANDLE)> {
		spawn_inner(options)
	}

	fn spawn_inner(
		options: PatchrightPipeSpawnOptions,
	) -> Result<(Arc<Inner>, HANDLE, HANDLE, HANDLE)> {
		validate_patchright_launch(&options)?;

		let mut child_handles: Vec<HANDLE> = Vec::with_capacity(5);
		let child_stdin = create_nul_handle(FILE_GENERIC_READ)?;
		child_handles.push(child_stdin);
		let (stdout_read, stdout_write_child) = create_child_output_pipe()?;
		child_handles.push(stdout_write_child);
		let (stderr_read, stderr_write_child) = create_child_output_pipe()?;
		child_handles.push(stderr_write_child);
		let (cdp_write_parent, cdp_read_child) = create_child_input_pipe()?;
		child_handles.push(cdp_read_child);
		let (cdp_read_parent, cdp_write_child) = create_child_output_pipe()?;
		child_handles.push(cdp_write_child);

		let mut stdio_buffer = build_stdio_buffer(&child_handles);
		let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
		startup.StartupInfo.cb =
			u32::try_from(size_of::<STARTUPINFOEXW>()).expect("STARTUPINFOEXW size fits u32");
		startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
		startup.StartupInfo.wShowWindow = if options.windows_hide.unwrap_or(true) {
			SW_HIDE
		} else {
			SW_SHOWDEFAULT
		} as u16;
		startup.StartupInfo.cbReserved2 = u16::try_from(stdio_buffer.len())
			.map_err(|_| Error::from_reason("stdio buffer too large"))?;
		startup.StartupInfo.lpReserved2 = stdio_buffer.as_mut_ptr();
		startup.StartupInfo.hStdInput = child_stdin;
		startup.StartupInfo.hStdOutput = stdout_write_child;
		startup.StartupInfo.hStdError = stderr_write_child;

		let mut attr_size = 0usize;
		unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_size) };
		let mut attr_storage = vec![0u8; attr_size];
		let attr_list = attr_storage.as_mut_ptr().cast::<_>();
		if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) } == 0 {
			cleanup_handles(&child_handles);
			cleanup_handles(&[stdout_read, stderr_read, cdp_write_parent, cdp_read_parent]);
			return Err(last_error("InitializeProcThreadAttributeList"));
		}
		let attr_guard = AttributeListGuard(attr_list);
		if unsafe {
			UpdateProcThreadAttribute(
				attr_list,
				0,
				PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
				child_handles.as_mut_ptr().cast::<c_void>(),
				child_handles.len() * size_of::<HANDLE>(),
				null_mut(),
				null_mut(),
			)
		} == 0
		{
			drop(attr_guard);
			cleanup_handles(&child_handles);
			cleanup_handles(&[stdout_read, stderr_read, cdp_write_parent, cdp_read_parent]);
			return Err(last_error("UpdateProcThreadAttribute"));
		}
		startup.lpAttributeList = attr_list as LPPROC_THREAD_ATTRIBUTE_LIST;

		let mut command_line = wide_null(&command_line(&options.command, &options.args));
		let application = wide_null(&options.command);
		let cwd = options.cwd.as_ref().map(|value| wide_null(value));
		let env = options.env.as_ref().map(build_env_block);
		let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
		let mut flags = CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
		if options.windows_hide.unwrap_or(true) {
			flags |= CREATE_NO_WINDOW;
		}

		let created = unsafe {
			CreateProcessW(
				application.as_ptr(),
				command_line.as_mut_ptr(),
				null(),
				null(),
				1,
				flags,
				env.as_ref()
					.map_or(null(), |block| block.as_ptr().cast::<c_void>()),
				cwd.as_ref().map_or(null(), |value| value.as_ptr()),
				&startup.StartupInfo,
				&mut process_info,
			)
		};
		drop(attr_guard);
		cleanup_handles(&child_handles);
		if created == 0 {
			cleanup_handles(&[stdout_read, stderr_read, cdp_write_parent, cdp_read_parent]);
			return Err(last_error("CreateProcessW"));
		}

		let inner = Arc::new(Inner {
			pid:         process_info.dwProcessId,
			process:     process_info.hProcess,
			main_thread: process_info.hThread,
			cdp_write:   Mutex::new(Some(cdp_write_parent)),
		});
		Ok((inner, stdout_read, stderr_read, cdp_read_parent))
	}

	struct AttributeListGuard(LPPROC_THREAD_ATTRIBUTE_LIST);
	impl Drop for AttributeListGuard {
		fn drop(&mut self) {
			unsafe { DeleteProcThreadAttributeList(self.0) };
		}
	}

	pub fn write_all(handle: HANDLE, bytes: &[u8]) -> Result<()> {
		let mut offset = 0usize;
		while offset < bytes.len() {
			let remaining = &bytes[offset..];
			let chunk_len = remaining.len().min(u32::MAX as usize);
			let mut written = 0u32;
			let ok = unsafe {
				WriteFile(handle, remaining.as_ptr(), chunk_len as u32, &mut written, null_mut())
			};
			if ok == 0 {
				return Err(last_error("WriteFile"));
			}
			if written == 0 {
				return Err(Error::from_reason("WriteFile wrote zero bytes"));
			}
			offset += written as usize;
		}
		Ok(())
	}

	pub fn kill(inner: &Inner) -> Result<()> {
		let ok = unsafe { TerminateProcess(inner.process, 1) };
		if ok == 0 {
			return Err(last_error("TerminateProcess"));
		}
		Ok(())
	}

	pub fn wait_exit(inner: Arc<Inner>) -> Option<u32> {
		let wait = unsafe { WaitForSingleObject(inner.process, INFINITE) };
		if wait != WAIT_OBJECT_0 {
			return None;
		}
		let mut code = 0u32;
		if unsafe { GetExitCodeProcess(inner.process, &mut code) } == 0 || code == STILL_ACTIVE {
			None
		} else {
			Some(code)
		}
	}

	pub fn read_loop(handle_value: usize, mut on_chunk: impl FnMut(Vec<u8>) + Send + 'static) {
		let handle = handle_value as HANDLE;
		let mut buf = vec![0u8; 64 * 1024];
		loop {
			let mut read = 0u32;
			let ok =
				unsafe { ReadFile(handle, buf.as_mut_ptr(), buf.len() as u32, &mut read, null_mut()) };
			if ok == 0 || read == 0 {
				break;
			}
			on_chunk(buf[..read as usize].to_vec());
		}
		unsafe { CloseHandle(handle) };
	}

	fn create_nul_handle(access: u32) -> Result<HANDLE> {
		let sa = inheritable_sa();
		let path = wide_null("NUL");
		let handle = unsafe {
			CreateFileW(
				path.as_ptr(),
				access,
				FILE_SHARE_READ | FILE_SHARE_WRITE,
				&sa,
				OPEN_EXISTING,
				FILE_ATTRIBUTE_NORMAL,
				null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			Err(last_error("CreateFileW(NUL)"))
		} else {
			Ok(handle)
		}
	}

	fn create_child_output_pipe() -> Result<(HANDLE, HANDLE)> {
		let sa = inheritable_sa();
		let mut read = null_mut();
		let mut write = null_mut();
		if unsafe { CreatePipe(&mut read, &mut write, &sa, 0) } == 0 {
			return Err(last_error("CreatePipe"));
		}
		if unsafe { SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0) } == 0 {
			cleanup_handles(&[read, write]);
			return Err(last_error("SetHandleInformation"));
		}
		Ok((read, write))
	}

	fn create_child_input_pipe() -> Result<(HANDLE, HANDLE)> {
		let sa = inheritable_sa();
		let mut read = null_mut();
		let mut write = null_mut();
		if unsafe { CreatePipe(&mut read, &mut write, &sa, 0) } == 0 {
			return Err(last_error("CreatePipe"));
		}
		if unsafe { SetHandleInformation(write, HANDLE_FLAG_INHERIT, 0) } == 0 {
			cleanup_handles(&[read, write]);
			return Err(last_error("SetHandleInformation"));
		}
		Ok((write, read))
	}

	fn inheritable_sa() -> SECURITY_ATTRIBUTES {
		SECURITY_ATTRIBUTES {
			nLength:              u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
				.expect("SECURITY_ATTRIBUTES size fits u32"),
			lpSecurityDescriptor: null_mut(),
			bInheritHandle:       1,
		}
	}

	fn cleanup_handles(handles: &[HANDLE]) {
		for &handle in handles {
			if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
				unsafe { CloseHandle(handle) };
			}
		}
	}

	fn build_stdio_buffer(handles: &[HANDLE]) -> Vec<u8> {
		let count = handles.len();
		let handle_size = size_of::<HANDLE>();
		let mut buf = vec![0u8; size_of::<u32>() + count + std::mem::size_of_val(handles)];
		buf[..4].copy_from_slice(&(count as u32).to_ne_bytes());
		for i in 0..count {
			buf[4 + i] = if i == 0 { FOPEN | FDEV } else { FOPEN | FPIPE };
			let offset = 4 + count + handle_size * i;
			buf[offset..offset + handle_size].copy_from_slice(&(handles[i] as usize).to_ne_bytes());
		}
		buf
	}

	fn command_line(command: &str, args: &[String]) -> String {
		let mut parts = Vec::with_capacity(args.len() + 1);
		parts.push(quote_arg(command));
		parts.extend(args.iter().map(|arg| quote_arg(arg)));
		parts.join(" ")
	}

	fn quote_arg(arg: &str) -> String {
		if arg.is_empty() {
			return "\"\"".to_string();
		}
		let needs_quote = arg
			.bytes()
			.any(|b| matches!(b, b' ' | b'\t' | b'\n' | 0x0b | b'\"'));
		if !needs_quote {
			return arg.to_string();
		}
		let mut out = String::from("\"");
		let mut backslashes = 0usize;
		for ch in arg.chars() {
			if ch == '\\' {
				backslashes += 1;
				continue;
			}
			if ch == '"' {
				out.push_str(&"\\".repeat(backslashes * 2 + 1));
				out.push('"');
			} else {
				out.push_str(&"\\".repeat(backslashes));
				out.push(ch);
			}
			backslashes = 0;
		}
		out.push_str(&"\\".repeat(backslashes * 2));
		out.push('"');
		out
	}

	fn wide_null(value: &str) -> Vec<u16> {
		value.encode_utf16().chain(std::iter::once(0)).collect()
	}

	fn build_env_block(env: &HashMap<String, String>) -> Vec<u16> {
		let mut entries: Vec<_> = env.iter().collect();
		entries.sort_by_key(|entry| entry.0.to_ascii_uppercase());
		let mut out = Vec::new();
		for (key, value) in entries {
			out.extend(format!("{key}={value}").encode_utf16());
			out.push(0);
		}
		out.push(0);
		out
	}

	fn last_error(operation: &str) -> Error {
		Error::from_reason(format!("{operation} failed: {}", io::Error::last_os_error()))
	}
}

#[cfg(unix)]
mod platform {
	use std::{
		io,
		os::{
			fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd},
			unix::process::CommandExt,
		},
		process::{Child, Command, Stdio},
		sync::{Arc, Mutex},
	};

	use napi::bindgen_prelude::*;

	use super::{PatchrightPipeSpawnOptions, validate_patchright_launch};

	pub struct Inner {
		pub pid:       u32,
		pub child:     Mutex<Option<Child>>,
		pub cdp_write: Mutex<Option<OwnedFd>>,
	}

	impl Inner {
		pub fn write_cdp(&self, bytes: &[u8]) -> Result<()> {
			let guard = self
				.cdp_write
				.lock()
				.map_err(|_| Error::from_reason("cdp_write lock poisoned"))?;
			let handle = guard
				.as_ref()
				.ok_or_else(|| Error::from_reason("cdp_write is closed"))?;
			write_all(handle, bytes)
		}

		pub fn close_cdp(&self) -> Result<()> {
			if let Ok(mut guard) = self.cdp_write.lock() {
				guard.take();
			}
			Ok(())
		}
	}

	pub fn spawn(
		options: PatchrightPipeSpawnOptions,
	) -> Result<(Arc<Inner>, OwnedFd, OwnedFd, OwnedFd)> {
		validate_patchright_launch(&options)?;

		let (cdp_read_child, cdp_write_parent) = pipe()?;
		let (cdp_read_parent, cdp_write_child) = pipe()?;
		let child_fd3 = cdp_read_child.as_raw_fd();
		let child_fd4 = cdp_write_child.as_raw_fd();

		let mut command = Command::new(&options.command);
		command.args(&options.args);
		command.stdin(Stdio::null());
		command.stdout(Stdio::piped());
		command.stderr(Stdio::piped());
		if let Some(cwd) = &options.cwd {
			command.current_dir(cwd);
		}
		if let Some(env) = &options.env {
			command.env_clear();
			command.envs(env);
		}
		unsafe {
			command.pre_exec(move || {
				dup_to(child_fd3, 3)?;
				dup_to(child_fd4, 4)?;
				Ok(())
			});
		}

		let mut child = command
			.spawn()
			.map_err(|err| Error::from_reason(format!("spawn failed: {err}")))?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| Error::from_reason("spawn did not expose stdout pipe"))?;
		let stderr = child
			.stderr
			.take()
			.ok_or_else(|| Error::from_reason("spawn did not expose stderr pipe"))?;
		let pid = child.id();
		let stdout = unsafe { OwnedFd::from_raw_fd(stdout.into_raw_fd()) };
		let stderr = unsafe { OwnedFd::from_raw_fd(stderr.into_raw_fd()) };
		let inner = Arc::new(Inner {
			pid,
			child: Mutex::new(Some(child)),
			cdp_write: Mutex::new(Some(cdp_write_parent)),
		});
		drop(cdp_read_child);
		drop(cdp_write_child);
		Ok((inner, stdout, stderr, cdp_read_parent))
	}

	pub fn write_all(handle: &OwnedFd, bytes: &[u8]) -> Result<()> {
		let fd = handle.as_raw_fd();
		let mut offset = 0usize;
		while offset < bytes.len() {
			let chunk = &bytes[offset..];
			let written = unsafe { libc::write(fd, chunk.as_ptr().cast(), chunk.len()) };
			if written < 0 {
				return Err(last_error("write"));
			}
			if written == 0 {
				return Err(Error::from_reason("write wrote zero bytes"));
			}
			offset += written as usize;
		}
		Ok(())
	}

	pub fn kill(inner: &Inner) -> Result<()> {
		// Send SIGTERM directly via pid — don't lock inner.child, which is held
		// by wait_exit() until the process actually exits. Locking here would
		// deadlock forced cleanup when the browser is unresponsive.
		if inner.pid > 0 && unsafe { libc::kill(inner.pid as i32, libc::SIGTERM) } != 0 {
			return Err(last_error("kill"));
		}
		Ok(())
	}

	pub fn wait_exit(inner: Arc<Inner>) -> Option<u32> {
		// Take the child out of the mutex, then wait without holding the lock
		// so kill() can run concurrently.
		let mut child = inner.child.lock().ok()?.take()?;
		let status = child.wait().ok()?;
		status.code().and_then(|code| u32::try_from(code).ok())
	}

	pub fn read_loop(handle: OwnedFd, mut on_chunk: impl FnMut(Vec<u8>) + Send + 'static) {
		let fd = handle.as_raw_fd();
		let mut buf = vec![0u8; 64 * 1024];
		loop {
			let read = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
			if read <= 0 {
				break;
			}
			on_chunk(buf[..read as usize].to_vec());
		}
	}

	fn pipe() -> Result<(OwnedFd, OwnedFd)> {
		let mut fds = [0; 2];
		if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
			return Err(last_error("pipe"));
		}
		Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
	}

	fn dup_to(source: i32, target: i32) -> io::Result<()> {
		if source == target {
			return Ok(());
		}
		if unsafe { libc::dup2(source, target) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	fn last_error(operation: &str) -> Error {
		Error::from_reason(format!("{operation} failed: {}", io::Error::last_os_error()))
	}
}

#[cfg(not(any(target_os = "windows", unix)))]
mod platform {
	use std::sync::Arc;

	use napi::bindgen_prelude::*;

	use super::PatchrightPipeSpawnOptions;

	pub struct Inner {
		pub pid: u32,
	}

	impl Inner {
		pub fn write_cdp(&self, _bytes: &[u8]) -> Result<()> {
			Err(Error::from_reason("unsupported platform"))
		}

		pub fn close_cdp(&self) -> Result<()> {
			Err(Error::from_reason("unsupported platform"))
		}
	}

	pub fn spawn(_options: PatchrightPipeSpawnOptions) -> Result<(Arc<Inner>, (), (), ())> {
		Err(Error::from_reason("PatchrightPipeProcess is only implemented on Windows and Unix"))
	}

	pub fn write_all(_handle: (), _bytes: &[u8]) -> Result<()> {
		Err(Error::from_reason("PatchrightPipeProcess is only implemented on Windows and Unix"))
	}

	pub fn kill(_inner: &Inner) -> Result<()> {
		Err(Error::from_reason("PatchrightPipeProcess is only implemented on Windows and Unix"))
	}

	pub fn wait_exit(_inner: Arc<Inner>) -> Option<u32> {
		None
	}

	pub fn read_loop(_handle: (), _on_chunk: impl FnMut(Vec<u8>) + Send + 'static) {}
}

#[napi]
pub struct PatchrightPipeProcess {
	inner:    Arc<platform::Inner>,
	#[cfg(target_os = "windows")]
	stdout:   Mutex<Option<windows_sys::Win32::Foundation::HANDLE>>,
	#[cfg(target_os = "windows")]
	stderr:   Mutex<Option<windows_sys::Win32::Foundation::HANDLE>>,
	#[cfg(target_os = "windows")]
	cdp_read: Mutex<Option<windows_sys::Win32::Foundation::HANDLE>>,
	#[cfg(unix)]
	stdout:   Mutex<Option<std::os::fd::OwnedFd>>,
	#[cfg(unix)]
	stderr:   Mutex<Option<std::os::fd::OwnedFd>>,
	#[cfg(unix)]
	cdp_read: Mutex<Option<std::os::fd::OwnedFd>>,
}

#[napi]
impl PatchrightPipeProcess {
	#[napi(factory)]
	pub fn spawn(options: PatchrightPipeSpawnOptions) -> Result<Self> {
		let (inner, stdout, stderr, cdp_read) = platform::spawn(options)?;
		Ok(Self {
			inner,
			#[cfg(any(target_os = "windows", unix))]
			stdout: Mutex::new(Some(stdout)),
			#[cfg(any(target_os = "windows", unix))]
			stderr: Mutex::new(Some(stderr)),
			#[cfg(any(target_os = "windows", unix))]
			cdp_read: Mutex::new(Some(cdp_read)),
		})
	}

	#[napi(getter)]
	pub fn pid(&self) -> u32 {
		self.inner.pid
	}

	#[napi]
	pub fn write(&self, data: Either<String, Uint8Array>) -> Result<()> {
		let bytes: Vec<u8> = match data {
			Either::A(text) => text.into_bytes(),
			Either::B(bytes) => bytes.to_vec(),
		};
		self.inner.write_cdp(&bytes)
	}

	#[napi]
	pub fn close_stdin(&self) -> Result<()> {
		self.inner.close_cdp()
	}

	#[napi]
	pub fn kill(&self) -> Result<()> {
		platform::kill(&self.inner)
	}

	#[napi]
	pub fn on_data(
		&self,
		#[napi(ts_arg_type = "(err: null | Error, data: Uint8Array) => void")]
		callback: ThreadsafeFunction<Uint8Array>,
	) -> Result<()> {
		self.start_reader(StreamKind::Cdp, callback)
	}

	#[napi]
	pub fn on_stdout(
		&self,
		#[napi(ts_arg_type = "(err: null | Error, data: Uint8Array) => void")]
		callback: ThreadsafeFunction<Uint8Array>,
	) -> Result<()> {
		self.start_reader(StreamKind::Stdout, callback)
	}

	#[napi]
	pub fn on_stderr(
		&self,
		#[napi(ts_arg_type = "(err: null | Error, data: Uint8Array) => void")]
		callback: ThreadsafeFunction<Uint8Array>,
	) -> Result<()> {
		self.start_reader(StreamKind::Stderr, callback)
	}

	#[napi]
	pub fn on_exit(
		&self,
		#[napi(ts_arg_type = "(err: null | Error, exit: PatchrightPipeExit) => void")]
		callback: ThreadsafeFunction<PatchrightPipeExit>,
	) {
		let inner = Arc::clone(&self.inner);
		thread::spawn(move || {
			let exit_code = platform::wait_exit(inner);
			callback
				.call(Ok(PatchrightPipeExit { exit_code }), ThreadsafeFunctionCallMode::NonBlocking);
		});
	}

	fn start_reader(
		&self,
		kind: StreamKind,
		callback: ThreadsafeFunction<Uint8Array>,
	) -> Result<()> {
		#[cfg(target_os = "windows")]
		{
			let handle = match kind {
				StreamKind::Cdp => self.cdp_read.lock(),
				StreamKind::Stdout => self.stdout.lock(),
				StreamKind::Stderr => self.stderr.lock(),
			}
			.map_err(|_| Error::from_reason("patchright pipe reader lock poisoned"))?
			.take()
			.ok_or_else(|| Error::from_reason("patchright pipe reader already started"))?;
			let handle_value = handle as usize;
			thread::spawn(move || {
				platform::read_loop(handle_value, move |chunk| {
					callback.call(Ok(Uint8Array::from(chunk)), ThreadsafeFunctionCallMode::NonBlocking);
				});
			});
			Ok(())
		}
		#[cfg(unix)]
		{
			let handle = match kind {
				StreamKind::Cdp => self.cdp_read.lock(),
				StreamKind::Stdout => self.stdout.lock(),
				StreamKind::Stderr => self.stderr.lock(),
			}
			.map_err(|_| Error::from_reason("patchright pipe reader lock poisoned"))?
			.take()
			.ok_or_else(|| Error::from_reason("patchright pipe reader already started"))?;
			thread::spawn(move || {
				platform::read_loop(handle, move |chunk| {
					callback.call(Ok(Uint8Array::from(chunk)), ThreadsafeFunctionCallMode::NonBlocking);
				});
			});
			Ok(())
		}
		#[cfg(not(any(target_os = "windows", unix)))]
		{
			let _ = (kind, callback);
			Err(Error::from_reason("PatchrightPipeProcess is only implemented on Windows and Unix"))
		}
	}
}

#[derive(Clone, Copy)]
enum StreamKind {
	Cdp,
	Stdout,
	Stderr,
}
