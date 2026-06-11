// Minimal zstd codec: clean C ABI over the zstd crate. malloc-based buffer exchange.
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn cz_alloc(len: usize) -> *mut u8 {
    if len == 0 { return std::ptr::null_mut(); }
    unsafe { alloc(Layout::from_size_align_unchecked(len, 1)) }
}
#[no_mangle]
pub extern "C" fn cz_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len != 0 {
        unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len, 1)); }
    }
}
#[no_mangle]
pub extern "C" fn cz_bound(src_len: usize) -> usize { zstd_safe::compress_bound(src_len) }

// Compress src[0..src_len] into dst[0..dst_cap] at `level`. Returns written bytes, or 0 on error.
#[no_mangle]
pub extern "C" fn cz_compress(dst: *mut u8, dst_cap: usize, src: *const u8, src_len: usize, level: i32) -> usize {
    let s = unsafe { std::slice::from_raw_parts(src, src_len) };
    let d = unsafe { std::slice::from_raw_parts_mut(dst, dst_cap) };
    match zstd_safe::compress(d, s, level) {
        Ok(n) => n,
        Err(_) => 0,
    }
}
// Decompress src into dst[0..dst_cap]. Returns written bytes, or 0 on error.
#[no_mangle]
pub extern "C" fn cz_decompress(dst: *mut u8, dst_cap: usize, src: *const u8, src_len: usize) -> usize {
    let s = unsafe { std::slice::from_raw_parts(src, src_len) };
    let d = unsafe { std::slice::from_raw_parts_mut(dst, dst_cap) };
    match zstd_safe::decompress(d, s) {
        Ok(n) => n,
        Err(_) => 0,
    }
}

// Decompressed size of a zstd frame, or 0 if unknown/empty/error. Lets the host size the dst
// buffer from the frame header alone (no out-of-band length needed).
#[no_mangle]
pub extern "C" fn cz_frame_size(src: *const u8, src_len: usize) -> usize {
    let s = unsafe { std::slice::from_raw_parts(src, src_len) };
    match zstd_safe::get_frame_content_size(s) {
        Ok(Some(n)) => n as usize,
        _ => 0,
    }
}
