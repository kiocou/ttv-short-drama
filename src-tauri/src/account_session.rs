//! Windows user-scoped protection for account sessions stored in SQLite.

const ENTROPY: &[u8] = b"TTV Short Drama account session v1";

#[cfg(windows)]
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if plain.is_empty() || plain.len() > u32::MAX as usize {
        return Err("账号会话长度无效。".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let protected = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if protected == 0 {
        return Err(format!("Windows 账号会话加密失败（{}）。", unsafe {
            windows_sys::Win32::Foundation::GetLastError()
        }));
    }
    if output.pbData.is_null() || output.cbData == 0 {
        unsafe { LocalFree(output.pbData.cast()) };
        return Err("Windows 返回了空的账号会话密文。".into());
    }
    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(encrypted)
}

#[cfg(not(windows))]
pub fn protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err("账号会话安全存储仅支持 Windows。".into())
}

#[cfg(windows)]
pub fn unprotect(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if encrypted.is_empty() || encrypted.len() > u32::MAX as usize {
        return Err("加密后的账号会话长度无效。".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let unprotected = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if unprotected == 0 {
        return Err(format!("Windows 账号会话解密失败（{}）。", unsafe {
            windows_sys::Win32::Foundation::GetLastError()
        }));
    }
    if output.pbData.is_null() || output.cbData == 0 {
        unsafe { LocalFree(output.pbData.cast()) };
        return Err("Windows 返回了空的账号会话明文。".into());
    }
    let plain =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(plain)
}

#[cfg(not(windows))]
pub fn unprotect(_encrypted: &[u8]) -> Result<Vec<u8>, String> {
    Err("账号会话安全存储仅支持 Windows。".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::{protect, unprotect};

    #[test]
    fn dpapi_round_trip_keeps_ciphertext_distinct_from_session() {
        let session = b"sensitive-account-session";
        let encrypted = protect(session).expect("DPAPI protect");
        assert_ne!(encrypted, session);
        assert_eq!(unprotect(&encrypted).expect("DPAPI unprotect"), session);
        assert!(unprotect(b"not DPAPI data").is_err());
    }
}
