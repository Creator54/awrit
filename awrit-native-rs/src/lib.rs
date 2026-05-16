#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use napi::bindgen_prelude::*;
use nix::fcntl::OFlag;
use nix::sys::mman::{mmap, munmap, shm_open, shm_unlink, MapFlags, ProtFlags};
use nix::sys::stat::Mode;
use nix::unistd::ftruncate;
use std::num::NonZeroUsize;
use std::time::{SystemTime, UNIX_EPOCH};

mod term;
pub use term::*;
mod input;
pub use input::*;

#[napi(object)]
pub struct DirtyRect {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}

#[napi(custom_finalize)]
pub struct ShmGraphicBuffer {
  name: String,
  name_base64: String,
  size: u32,
  fd: Option<std::os::unix::io::RawFd>,
  ptr: Option<std::ptr::NonNull<std::ffi::c_void>>,
}

impl ObjectFinalize for ShmGraphicBuffer {
  fn finalize(self, mut _env: Env) -> Result<()> {
    if let Some(ptr) = self.ptr {
      unsafe {
        munmap(ptr, self.size as usize).ok();
      }
    }
    // fd is automatically closed if we store it as a file or similar, 
    // but here we store it as RawFd. 
    if let Some(fd) = self.fd {
      unsafe {
        nix::unistd::close(fd).ok();
      }
    }
    // Attempt to unlink the shared memory, doesn't really matter if it fails
    let _ = shm_unlink(self.name());
    Ok(())
  }
}

#[napi]
impl ShmGraphicBuffer {
  /// Creates a new shared memory buffer with a unique name with the provided size
  #[napi(constructor)]
  pub fn new(size: u32) -> Self {
    let timestamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();

    // Convert timestamp to hex, keeping the least significant (most unique) digits
    let hex = format!("{:x}", timestamp);
    let significant_part = if hex.len() > 23 {
      &hex[hex.len() - 23..]
    } else {
      &hex
    };
    let name = format!("/awrit_{}", significant_part);
    let name_base64 = BASE64.encode(name.as_bytes());

    Self {
      name,
      name_base64,
      size,
      fd: None,
      ptr: None,
    }
  }

  fn ensure_mapped(&mut self) -> napi::Result<*mut u8> {
    if let Some(ptr) = self.ptr {
      return Ok(ptr.as_ptr() as *mut u8);
    }

    let fd = shm_open(
      self.name(),
      OFlag::O_CREAT | OFlag::O_RDWR,
      Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(|e| napi::Error::from_reason(format!("Failed to open shared memory: {}", e)))?;

    ftruncate(fd, self.size as i64)
      .map_err(|e| napi::Error::from_reason(format!("Failed to truncate shared memory: {}", e)))?;

    let size = NonZeroUsize::new(self.size as usize)
      .ok_or_else(|| napi::Error::from_reason("Size must be non-zero"))?;

    let ptr = unsafe {
      mmap(
        None,
        size,
        ProtFlags::PROT_READ | ProtFlags::PROT_WRITE,
        MapFlags::MAP_SHARED,
        fd,
        0,
      )
      .map_err(|e| napi::Error::from_reason(format!("Failed to mmap shared memory: {}", e)))?
    };

    self.fd = Some(fd);
    self.ptr = Some(ptr);

    Ok(ptr.as_ptr() as *mut u8)
  }

  /// Returns a reference to the shared memory name
  pub fn name(&self) -> &str {
    &self.name
  }

  /// Returns the shared memory name as a base64 encoded string
  #[napi(getter)]
  pub fn name_base64(&self) -> String {
    self.name_base64.clone()
  }

  /// Creates and truncates the shared memory segment to the specified size, filling it with zeros
  #[napi]
  pub fn write_empty(&mut self) -> napi::Result<()> {
    self.ensure_mapped()?;
    Ok(())
  }

  /// Writes an image buffer to the shared memory at the specified dirty rectangle
  #[napi]
  pub fn write(
    &mut self,
    buffer: Buffer,
    image_width: u32,
    dirty_rect: Option<DirtyRect>,
  ) -> napi::Result<()> {
    let dst_ptr = self.ensure_mapped()?;
    let src_slice = buffer.as_ref();
    let dst_slice = unsafe { std::slice::from_raw_parts_mut(dst_ptr, self.size as usize) };

    match dirty_rect {
      Some(rect) => {
        let bgra_rect = bgra_to_rgba::Rect {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        if !bgra_to_rgba::bgra_to_rgba_inplace(src_slice, dst_slice, image_width, bgra_rect) {
          return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
        }
      }
      None => {
        if !bgra_to_rgba::bgra_to_rgba(src_slice, dst_slice) {
          return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
        }
      }
    }

    Ok(())
  }
}
