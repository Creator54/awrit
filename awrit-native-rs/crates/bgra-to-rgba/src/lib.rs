#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

#[cfg(target_arch = "aarch64")]
use std::arch::aarch64::*;

const BYTES_PER_PIXEL: usize = 4;
const CHUNK_SIZE: usize = BYTES_PER_PIXEL * 1024 * 1024;

#[derive(Copy, Clone)]
pub struct Rect {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}

#[inline]
pub fn bgra_to_rgba(src: &[u8], dst: &mut [u8]) -> bool {
  if src.len() != dst.len() {
    return false;
  }

  // For large buffers, use parallel processing
  if src.len() > CHUNK_SIZE {
    use rayon::prelude::*;
    src
      .par_chunks(CHUNK_SIZE)
      .zip(dst.par_chunks_mut(CHUNK_SIZE))
      .for_each(|(src_chunk, dst_chunk)| unsafe {
        bgra_to_rgba_chunk(src_chunk, dst_chunk);
      });
    return true;
  }

  unsafe {
    bgra_to_rgba_chunk(src, dst);
  }

  return true;
}

#[inline]
pub fn bgra_to_rgba_inplace(src: &[u8], dst: &mut [u8], stride: u32, rect: Rect) -> bool {
  // Validate input dimensions
  if rect.x + rect.width > stride {
    return false;
  }
  let total_height = rect.y + rect.height;
  if src.len() < (stride * total_height) as usize * BYTES_PER_PIXEL {
    return false;
  }
  if dst.len() < (stride * total_height) as usize * BYTES_PER_PIXEL {
    return false;
  }

  let offset = (rect.y * stride + rect.x) as usize * BYTES_PER_PIXEL;

  // For large buffers, use parallel processing
  if rect.width * rect.height > (CHUNK_SIZE / BYTES_PER_PIXEL) as u32 {
    use rayon::prelude::*;
    let chunk_height = (CHUNK_SIZE / (rect.width as usize * BYTES_PER_PIXEL)).max(1);
    
    (0..rect.height).into_par_iter().step_by(chunk_height as usize).for_each(|start_y| {
      let height = (rect.height - start_y).min(chunk_height as u32);
      let row_offset = offset + (start_y * stride) as usize * BYTES_PER_PIXEL;

      unsafe {
        bgra_to_rgba_rect_chunk(
          src,
          dst,
          stride,
          Rect {
            x: rect.x,
            y: 0,
            width: rect.width,
            height: height,
          },
          row_offset,
          Some(stride),
          row_offset,
        );
      }
    });
    return true;
  }

  unsafe {
    bgra_to_rgba_rect_chunk(src, dst, stride, rect, offset, Some(stride), offset);
  }

  return true;
}

#[inline]
pub fn bgra_to_rgba_rect(src: &[u8], dst: &mut [u8], image_width: u32, src_rect: Rect) -> bool {
  // Validate input dimensions
  if src_rect.x + src_rect.width > image_width {
    return false;
  }
  if src.len() < (image_width * (src_rect.y + src_rect.height)) as usize * BYTES_PER_PIXEL {
    return false;
  }
  if dst.len() < (src_rect.width * src_rect.height) as usize * BYTES_PER_PIXEL {
    return false;
  }

  let src_start = (src_rect.y * image_width + src_rect.x) as usize * BYTES_PER_PIXEL;

  // For large buffers, use parallel processing
  if src_rect.width * src_rect.height > (CHUNK_SIZE / BYTES_PER_PIXEL) as u32 {
    use rayon::prelude::*;
    let chunk_height = (CHUNK_SIZE / (src_rect.width as usize * BYTES_PER_PIXEL)).max(1);
    let chunk_size = chunk_height * src_rect.width as usize * BYTES_PER_PIXEL;

    dst
      .par_chunks_mut(chunk_size)
      .enumerate()
      .for_each(|(chunk_idx, dst_chunk)| {
        let start_y = chunk_idx * chunk_height;
        let height = (dst_chunk.len() / (src_rect.width as usize * BYTES_PER_PIXEL))
          .min(src_rect.height as usize - start_y);

        if height > 0 {
          let chunk_src_start = src_start + start_y * image_width as usize * BYTES_PER_PIXEL;

          unsafe {
            bgra_to_rgba_rect_chunk(
              src,
              dst_chunk,
              image_width,
              Rect {
                x: src_rect.x,
                y: 0,
                width: src_rect.width,
                height: height as u32,
              },
              chunk_src_start,
              None,
              0,
            );
          }
        }
      });
    return true;
  }

  // Process the entire rect at once for small buffers
  unsafe {
    bgra_to_rgba_rect_chunk(src, dst, image_width, src_rect, src_start, None, 0);
  }

  return true;
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn bgra_to_rgba_chunk(src: &[u8], dst: &mut [u8]) { unsafe {
  const ALIGN_SIZE: usize = 32;
  let len = src.len();
  let src_ptr = src.as_ptr();
  let dst_ptr = dst.as_mut_ptr();
  let src_aligned = src_ptr as usize % ALIGN_SIZE == 0;
  let dst_aligned = dst_ptr as usize % ALIGN_SIZE == 0;

  // Shuffle pattern: B G R A -> R G B A
  #[rustfmt::skip]
  let shuffle = _mm256_setr_epi8(
    2, 1, 0, 3, 
    6, 5, 4, 7,
    10, 9, 8, 11,
    14, 13, 12, 15,
    18, 17, 16, 19,
    22, 21, 20, 23,
    26, 25, 24, 27,
    30, 29, 28, 31,
  );

  for i in (0..len - len % ALIGN_SIZE).step_by(ALIGN_SIZE) {
    let bgra = if src_aligned {
      _mm256_load_si256(src_ptr.add(i) as *const __m256i)
    } else {
      _mm256_loadu_si256(src_ptr.add(i) as *const __m256i)
    };

    let rgba = _mm256_shuffle_epi8(bgra, shuffle);

    // Use non-temporal store for large buffers
    if len > CHUNK_SIZE {
      _mm256_stream_si256(dst_ptr.add(i) as *mut __m256i, rgba);
    } else if dst_aligned {
      _mm256_store_si256(dst_ptr.add(i) as *mut __m256i, rgba);
    } else {
      _mm256_storeu_si256(dst_ptr.add(i) as *mut __m256i, rgba);
    }

    // Prefetch next chunk if we're not at the end
    if i + 2 * ALIGN_SIZE <= len {
      _mm_prefetch(src_ptr.add(i + ALIGN_SIZE) as *const i8, _MM_HINT_T0);
    }
  }

  // Handle remaining bytes
  for i in (len - len % ALIGN_SIZE..len).step_by(BYTES_PER_PIXEL) {
    dst[i] = src[i + 2];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i];
    dst[i + 3] = src[i + 3];
  }
}}

#[cfg(target_arch = "aarch64")]
#[inline(always)]
unsafe fn prefetch(ptr: *const u8) { unsafe {
    // On aarch64, we use PRFM (prefetch memory) instruction
    // This is equivalent to __builtin_prefetch
    core::arch::asm!(
        "prfm pldl1keep, [{0}]",
        in(reg) ptr,
        options(nostack, readonly)
    );
}}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn bgra_to_rgba_chunk(src: &[u8], dst: &mut [u8]) { unsafe {
  const ALIGN_SIZE: usize = 16;
  let len = src.len();
  let src_ptr = src.as_ptr();
  let dst_ptr = dst.as_mut_ptr();
  let src_aligned = src_ptr as usize % ALIGN_SIZE == 0;
  let dst_aligned = dst_ptr as usize % ALIGN_SIZE == 0;

  static SHUFFLE_TABLE: [u8; 16] = [
    2, 1, 0, 3,    // First pixel
    6, 5, 4, 7,    // Second pixel
    10, 9, 8, 11,  // Third pixel
    14, 13, 12, 15 // Fourth pixel
  ];

  for i in (0..len - len % ALIGN_SIZE).step_by(ALIGN_SIZE) {
    let bgra = if src_aligned {
      vld1q_u8_aligned(src_ptr.add(i))
    } else {
      vld1q_u8(src_ptr.add(i))
    };

    // Load the shuffle mask and apply it
    let tbl = vld1q_u8(SHUFFLE_TABLE.as_ptr());
    let rgba = vqtbl1q_u8(bgra, tbl);

    // Use non-temporal store for large buffers
    if len > CHUNK_SIZE {
      vst1q_u8_nontemporal(dst_ptr.add(i), rgba);
    } else if dst_aligned {
      vst1q_u8_aligned(dst_ptr.add(i), rgba);
    } else {
      vst1q_u8(dst_ptr.add(i), rgba);
    }

    // Prefetch next chunk if we're not at the end
    if i + 2 * ALIGN_SIZE <= len {
      prefetch(src_ptr.add(i + ALIGN_SIZE));
    }
  }

  // Handle remaining bytes
  for i in (len - len % ALIGN_SIZE..len).step_by(BYTES_PER_PIXEL) {
    dst[i] = src[i + 2];     // R <- B
    dst[i + 1] = src[i + 1]; // G <- G
    dst[i + 2] = src[i];     // B <- R
    dst[i + 3] = src[i + 3]; // A <- A
  }
}}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn vld1q_u8_aligned(ptr: *const u8) -> uint8x16_t { unsafe {
    // Initialize result with zeros to avoid uninitialized memory
    let mut result: uint8x16_t = vdupq_n_u8(0);
        std::ptr::copy_nonoverlapping(ptr, &mut result as *mut _ as *mut u8, 16);
    result
}}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn vst1q_u8_aligned(ptr: *mut u8, val: uint8x16_t) { unsafe {
        std::ptr::copy_nonoverlapping(&val as *const _ as *const u8, ptr, 16);
}}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn vst1q_u8_nontemporal(ptr: *mut u8, val: uint8x16_t) { unsafe {
        std::ptr::write_volatile(ptr as *mut uint8x16_t, val);
}}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn bgra_to_rgba_rect_chunk(
  src: &[u8],
  dst: &mut [u8],
  image_width: u32,
  src_rect: Rect,
  src_start: usize,
  dst_stride_pixels: Option<u32>,
  dst_start: usize,
) { unsafe {
  const ALIGN_SIZE: usize = 32;
  let pixels_per_simd = ALIGN_SIZE / BYTES_PER_PIXEL;
  let src_ptr = src.as_ptr();
  let dst_ptr = dst.as_mut_ptr();

  // Shuffle pattern: B G R A -> R G B A
  let shuffle = _mm256_setr_epi8(
    2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15, 18, 17, 16, 19, 22, 21, 20, 23, 26, 25,
    24, 27, 30, 29, 28, 31,
  );

  let rect_width = src_rect.width as usize;
  let rect_height = src_rect.height as usize;
  let src_stride = image_width as usize * BYTES_PER_PIXEL;
  let dst_stride = dst_stride_pixels.unwrap_or(src_rect.width) as usize * BYTES_PER_PIXEL;

  // Process full SIMD width strips
  let simd_width = (rect_width / pixels_per_simd) * pixels_per_simd;

  for y in 0..rect_height {
    let src_row = src_start + y * src_stride;
    let dst_row = dst_start + y * dst_stride;

    // Prefetch next row if not at the last row
    if y + 1 < rect_height {
      let next_src_row = src_row + src_stride;
      for x in (0..simd_width * BYTES_PER_PIXEL).step_by(64) {
        _mm_prefetch(src_ptr.add(next_src_row + x) as *const i8, _MM_HINT_T0);
      }
    }

    // Process SIMD-width chunks
    for x in (0..simd_width * BYTES_PER_PIXEL).step_by(ALIGN_SIZE) {
      let src_offset = src_row + x;
      let dst_offset = dst_row + x;

      // Prefetch next chunk in current row
      if x + ALIGN_SIZE < simd_width * BYTES_PER_PIXEL {
        _mm_prefetch(
          src_ptr.add(src_offset + ALIGN_SIZE) as *const i8,
          _MM_HINT_T0,
        );
      }

      let bgra = _mm256_loadu_si256(src_ptr.add(src_offset) as *const __m256i);
      let rgba = _mm256_shuffle_epi8(bgra, shuffle);

      // Use non-temporal store for large rectangles
      if rect_width * rect_height * BYTES_PER_PIXEL > CHUNK_SIZE {
        _mm256_stream_si256(dst_ptr.add(dst_offset) as *mut __m256i, rgba);
      } else {
        _mm256_storeu_si256(dst_ptr.add(dst_offset) as *mut __m256i, rgba);
      }
    }

    // Handle remaining pixels in this row
    for x in (simd_width * BYTES_PER_PIXEL..rect_width * BYTES_PER_PIXEL).step_by(BYTES_PER_PIXEL) {
      let src_offset = src_row + x;
      let dst_offset = dst_row + x;

      dst[dst_offset] = src[src_offset + 2]; // R
      dst[dst_offset + 1] = src[src_offset + 1]; // G
      dst[dst_offset + 2] = src[src_offset]; // B
      dst[dst_offset + 3] = src[src_offset + 3]; // A
    }
  }
}}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn bgra_to_rgba_rect_chunk(
  src: &[u8],
  dst: &mut [u8],
  image_width: u32,
  src_rect: Rect,
  src_start: usize,
  dst_stride_pixels: Option<u32>,
  dst_start: usize,
) { unsafe {
  const ALIGN_SIZE: usize = 16;
  let pixels_per_simd = ALIGN_SIZE / BYTES_PER_PIXEL;
  let src_ptr = src.as_ptr();
  let dst_ptr = dst.as_mut_ptr();

  let rect_width = src_rect.width as usize;
  let rect_height = src_rect.height as usize;
  let src_stride = image_width as usize * BYTES_PER_PIXEL;
  let dst_stride = dst_stride_pixels.unwrap_or(src_rect.width) as usize * BYTES_PER_PIXEL;

  // Process full SIMD width strips
  let simd_width = (rect_width / pixels_per_simd) * pixels_per_simd;

  for y in 0..rect_height {
    let src_row = src_start + y * src_stride;
    let dst_row = dst_start + y * dst_stride;

    // Prefetch next row if not at the last row
    if y + 1 < rect_height {
      let next_src_row = src_row + src_stride;
      for x in (0..simd_width * BYTES_PER_PIXEL).step_by(64) {
        prefetch(src_ptr.add(next_src_row + x));
      }
    }

    // Process SIMD-width chunks
    for x in (0..simd_width * BYTES_PER_PIXEL).step_by(ALIGN_SIZE) {
      let src_offset = src_row + x;
      let dst_offset = dst_row + x;

      // Prefetch next chunk in current row
      if x + ALIGN_SIZE < simd_width * BYTES_PER_PIXEL {
        prefetch(src_ptr.add(src_offset + ALIGN_SIZE));
      }

      let bgra = vld1q_u8(src_ptr.add(src_offset));
      let rgba = vrev64q_u8(vextq_u8(bgra, bgra, 8));
      let final_rgba = vcombine_u8(vget_low_u8(rgba), vget_high_u8(bgra));

      // Use non-temporal store for large rectangles
      if rect_width * rect_height * BYTES_PER_PIXEL > CHUNK_SIZE {
        vst1q_u8_nontemporal(dst_ptr.add(dst_offset), final_rgba);
      } else {
        vst1q_u8(dst_ptr.add(dst_offset), final_rgba);
      }
    }

    // Handle remaining pixels in this row
    for x in (simd_width * BYTES_PER_PIXEL..rect_width * BYTES_PER_PIXEL).step_by(BYTES_PER_PIXEL) {
      let src_offset = src_row + x;
      let dst_offset = dst_row + x;

      dst[dst_offset] = src[src_offset + 2]; // R
      dst[dst_offset + 1] = src[src_offset + 1]; // G
      dst[dst_offset + 2] = src[src_offset]; // B
      dst[dst_offset + 3] = src[src_offset + 3]; // A
    }
  }
}}

#[cfg(test)]
mod tests {
  use super::*;
  use std::alloc::{alloc, Layout};

  #[test]
  fn test_bgra_to_rgba() {
    let layout = Layout::from_size_align(32, 4).unwrap();
    let dst_ptr = unsafe { alloc(layout) };

    #[rustfmt::skip]
    let src = [
      255,128,64,255,
      100,150,200,255,
      50,75,25,255,
      10,20,30,255,
      1,2,3,4,
      5,6,7,8,
      9,10,11,12,
      13,14,15,16,
    ];

    unsafe {
      let dst = std::slice::from_raw_parts_mut(dst_ptr, 32);

      bgra_to_rgba(&src, dst);

      assert_eq!(dst[0], 64); // R
      assert_eq!(dst[1], 128); // G
      assert_eq!(dst[2], 255); // B
      assert_eq!(dst[3], 255); // A
      assert_eq!(dst[4], 200); // R
      assert_eq!(dst[5], 150); // G
      assert_eq!(dst[6], 100); // B
      assert_eq!(dst[7], 255); // A
    }

    unsafe {
      std::alloc::dealloc(dst_ptr, layout);
    }
  }

  #[test]
  fn test_bgra_to_rgba_rect() {
    // Create a 4x4 test image (16 pixels)
    #[rustfmt::skip]
    let src = [
      // Row 0
      1,2,3,4,      5,6,7,8,     9,10,11,12,    13,14,15,16,
      // Row 1
      17,18,19,20,  21,22,23,24, 25,26,27,28,   29,30,31,32,
      // Row 2
      33,34,35,36,  37,38,39,40, 41,42,43,44,   45,46,47,48,
      // Row 3
      49,50,51,52,  53,54,55,56, 57,58,59,60,   61,62,63,64,
    ];

    // Create a destination buffer for a 2x2 region
    let mut dst = vec![0u8; 16]; // 2x2 pixels * 4 bytes per pixel

    // Define a 2x2 rectangle starting at (1,1)
    let rect = Rect {
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    };

    // Convert the region
    bgra_to_rgba_rect(&src, &mut dst, 4, rect);

    // pixel 1,1
    assert_eq!(dst[0], 23); // R (was B)
    assert_eq!(dst[1], 22); // G
    assert_eq!(dst[2], 21); // B (was R)
    assert_eq!(dst[3], 24); // A

    // pixel 2,1
    assert_eq!(dst[4], 27); // R
    assert_eq!(dst[5], 26); // G
    assert_eq!(dst[6], 25); // B
    assert_eq!(dst[7], 28); // A

    // pixel 1,2
    assert_eq!(dst[8], 39); // R
    assert_eq!(dst[9], 38); // G
    assert_eq!(dst[10], 37); // B
    assert_eq!(dst[11], 40); // A

    // pixel 2,2
    assert_eq!(dst[12], 43); // R
    assert_eq!(dst[13], 42); // G
    assert_eq!(dst[14], 41); // B
    assert_eq!(dst[15], 44); // A
  }
}
