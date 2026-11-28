//! The COM class File Explorer creates for the entry, its class factory and
//! the two exports the package's surrogate calls.

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_NOTIMPL, E_POINTER, HMODULE,
    S_FALSE,
};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::System::Com::{
    CoTaskMemFree, IBindCtx, IClassFactory, IClassFactory_Impl, IServiceProvider,
};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::System::Ole::{IObjectWithSite, IObjectWithSite_Impl};
use windows::Win32::System::SystemServices::SFGAO_FLAGS;
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IFolderView, IShellItem,
    IShellItemArray, SHStrDupW, ECF_DEFAULT, ECS_ENABLED, ECS_HIDDEN, SIGDN_FILESYSPATH,
};
use windows_core::{implement, Interface, Ref, BOOL, GUID, HRESULT, HSTRING, PWSTR};

use crate::rule::{
    offers_location, title_for_language, SFGAO_FILESYSTEM, SFGAO_FOLDER, SFGAO_STREAM,
};
use crate::DESKTOP_EXE;

/// The class's CLSID; `CLSID_TEXT` is what the manifest writes.
const CLSID: GUID = GUID::from_u128(0x990fe47e_094a_4386_8446_81c6b0d971ca);

/// `DETACHED_PROCESS`: the desktop takes no console from the surrogate.
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// The directory this DLL was loaded from: the package's root, where the
/// desktop sits.
fn module_directory() -> Option<PathBuf> {
    let mut module = HMODULE::default();
    // SAFETY: the address is a function of this module, and the flags ask for
    // no reference count change, so nothing needs freeing.
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            windows_core::PCWSTR(module_directory as *const u16),
            &mut module,
        )
        .ok()?;
    }
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: the buffer is ours and its length is passed.
    let length = unsafe { GetModuleFileNameW(Some(module), &mut buffer) } as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    let path = PathBuf::from(String::from_utf16(&buffer[..length]).ok()?);
    path.parent().map(PathBuf::from)
}

/// A shell-allocated copy of `text`, as Explorer frees it.
fn shell_string(text: &str) -> windows_core::Result<PWSTR> {
    // SAFETY: SHStrDupW copies the string into memory the caller frees.
    unsafe { SHStrDupW(&HSTRING::from(text)) }
}

/// The command for `path`: the package's desktop, with the folder as one
/// argument, started in the package's directory, its stdio closed.
pub(crate) fn desktop_command(directory: &std::path::Path, path: &str) -> Command {
    let mut command = Command::new(directory.join(DESKTOP_EXE));
    command
        .arg("--open-folder")
        .arg(path)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS);
    command
}

#[implement(IExplorerCommand, IObjectWithSite)]
struct OpenInLasterm {
    site: Mutex<Option<windows_core::IUnknown>>,
}

impl OpenInLasterm {
    /// The item the entry acts on: the first of a non-null, non-empty
    /// selection; else the folder the view shows (a background click); else
    /// none.
    fn location(&self, items: Option<&IShellItemArray>) -> Option<IShellItem> {
        if let Some(items) = items {
            // SAFETY: plain COM calls on a live array.
            if unsafe { items.GetCount() }.is_ok_and(|count| count > 0) {
                return unsafe { items.GetItemAt(0) }.ok();
            }
        }
        let site = self.site.lock().ok()?.clone()?;
        let provider: IServiceProvider = site.cast().ok()?;
        // SID_SFolderView is IID_IFolderView (shlguid.h).
        // SAFETY: plain COM calls on live interfaces.
        let view: IFolderView = unsafe { provider.QueryService(&IFolderView::IID) }.ok()?;
        unsafe { view.GetFolder::<IShellItem>() }.ok()
    }

    /// The folder's path when the entry is offered for `item`.
    fn offered_path(item: &IShellItem) -> Option<String> {
        let mask = SFGAO_FLAGS(SFGAO_FILESYSTEM | SFGAO_FOLDER | SFGAO_STREAM);
        // SAFETY: plain COM calls on a live item; the name is freed below.
        let attributes = unsafe { item.GetAttributes(mask) }.ok()?;
        let name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.ok()?;
        let wide = unsafe { name.as_wide() }.to_vec();
        unsafe { CoTaskMemFree(Some(name.0 as *const c_void)) };
        if !offers_location(&wide, attributes.0) {
            return None;
        }
        String::from_utf16(&wide).ok()
    }
}

impl IExplorerCommand_Impl for OpenInLasterm_Impl {
    fn GetTitle(&self, _items: Ref<IShellItemArray>) -> windows_core::Result<PWSTR> {
        // SAFETY: plain call.
        shell_string(title_for_language(unsafe { GetUserDefaultUILanguage() }))
    }

    fn GetIcon(&self, _items: Ref<IShellItemArray>) -> windows_core::Result<PWSTR> {
        let directory = module_directory().ok_or_else(|| windows_core::Error::from(E_FAIL))?;
        shell_string(&format!("{},0", directory.join(DESKTOP_EXE).display()))
    }

    fn GetToolTip(&self, _items: Ref<IShellItemArray>) -> windows_core::Result<PWSTR> {
        Err(E_NOTIMPL.into())
    }

    fn GetCanonicalName(&self) -> windows_core::Result<GUID> {
        Ok(CLSID)
    }

    fn GetState(
        &self,
        items: Ref<IShellItemArray>,
        _ok_to_be_slow: BOOL,
    ) -> windows_core::Result<u32> {
        let offered = self
            .location(items.as_ref())
            .and_then(|item| OpenInLasterm::offered_path(&item))
            .is_some();
        Ok(if offered {
            ECS_ENABLED.0 as u32
        } else {
            ECS_HIDDEN.0 as u32
        })
    }

    fn Invoke(
        &self,
        items: Ref<IShellItemArray>,
        _context: Ref<IBindCtx>,
    ) -> windows_core::Result<()> {
        let Some(path) = self
            .location(items.as_ref())
            .and_then(|item| OpenInLasterm::offered_path(&item))
        else {
            return Ok(());
        };
        let directory = module_directory().ok_or_else(|| windows_core::Error::from(E_FAIL))?;
        match desktop_command(&directory, &path).spawn() {
            // Not waited for: the desktop runs for as long as its user keeps it.
            Ok(_child) => Ok(()),
            Err(error) => Err(match error.raw_os_error() {
                Some(code) => HRESULT::from_win32(code as u32).into(),
                None => E_FAIL.into(),
            }),
        }
    }

    fn GetFlags(&self) -> windows_core::Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> windows_core::Result<IEnumExplorerCommand> {
        Err(E_NOTIMPL.into())
    }
}

impl IObjectWithSite_Impl for OpenInLasterm_Impl {
    fn SetSite(&self, site: Ref<windows_core::IUnknown>) -> windows_core::Result<()> {
        *self
            .site
            .lock()
            .map_err(|_| windows_core::Error::from(E_FAIL))? = site.cloned();
        Ok(())
    }

    fn GetSite(&self, riid: *const GUID, site: *mut *mut c_void) -> windows_core::Result<()> {
        if site.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: checked non-null above.
        unsafe { *site = std::ptr::null_mut() };
        let current = self
            .site
            .lock()
            .map_err(|_| windows_core::Error::from(E_FAIL))?
            .clone();
        match current {
            // SAFETY: riid and site come from the caller, as QueryInterface's.
            Some(current) => unsafe { current.query(riid, site) }.ok(),
            None => Err(E_FAIL.into()),
        }
    }
}

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<windows_core::IUnknown>,
        riid: *const GUID,
        object: *mut *mut c_void,
    ) -> windows_core::Result<()> {
        if object.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: checked non-null above.
        unsafe { *object = std::ptr::null_mut() };
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let command: IExplorerCommand = OpenInLasterm {
            site: Mutex::new(None),
        }
        .into();
        // SAFETY: riid and object come from the caller, as QueryInterface's.
        unsafe { command.query(riid, object) }.ok()
    }

    fn LockServer(&self, _lock: BOOL) -> windows_core::Result<()> {
        Ok(())
    }
}

/// The surrogate asks this for the class factory of a CLSID.
///
/// # Safety
///
/// COM's contract: `rclsid` and `riid` point to GUIDs, `ppv` to writable
/// storage for an interface pointer.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() || rclsid.is_null() || riid.is_null() {
        return E_POINTER;
    }
    // SAFETY: checked non-null above; COM's contract for the rest.
    unsafe {
        *ppv = std::ptr::null_mut();
        if *rclsid != CLSID {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory.into();
        factory.query(riid, ppv)
    }
}

/// Never: the surrogate keeps this small library for its own lifetime.
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CLSID_TEXT;

    #[test]
    fn the_clsid_constant_matches_its_text() {
        assert_eq!(format!("{CLSID:?}").to_lowercase(), CLSID_TEXT);
    }
}
