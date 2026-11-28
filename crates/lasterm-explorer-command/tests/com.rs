//! The built DLL, loaded as the package's surrogate loads it: its exports, its
//! class factory, and the command File Explorer calls (#1236).
#![cfg(all(windows, feature = "com"))]

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use lasterm_explorer_command::rule::title_for_language;
use lasterm_explorer_command::{CLSID_TEXT, DESKTOP_EXE};
use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, E_NOTIMPL, HMODULE, POINT, S_FALSE};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, IBindCtx, IClassFactory, IServiceProvider,
    IServiceProvider_Impl, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Ole::IObjectWithSite;
use windows::Win32::System::SystemServices::SFGAO_FLAGS;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::PropertiesSystem::GETPROPERTYSTOREFLAGS;
use windows::Win32::UI::Shell::{
    IEnumShellItems, IExplorerCommand, IFolderView, IFolderView_Impl, IShellItem, IShellItemArray,
    IShellItemArray_Impl, SHCreateItemFromParsingName, _SVGIO, ECF_DEFAULT, ECS_ENABLED,
    ECS_HIDDEN, SIATTRIBFLAGS,
};
use windows_core::{implement, IUnknownImpl, Interface, Ref, GUID, HRESULT, HSTRING, PCSTR};

type GetClassObject =
    unsafe extern "system" fn(*const GUID, *const GUID, *mut *mut c_void) -> HRESULT;
type CanUnloadNow = unsafe extern "system" fn() -> HRESULT;

/// A selection of the given items, as Explorer passes one.
#[implement(IShellItemArray)]
struct Selection(Vec<IShellItem>);

impl IShellItemArray_Impl for Selection_Impl {
    fn BindToHandler(
        &self,
        _: Ref<IBindCtx>,
        _: *const GUID,
        _: *const GUID,
        _: *mut *mut c_void,
    ) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetPropertyStore(
        &self,
        _: GETPROPERTYSTOREFLAGS,
        _: *const GUID,
        _: *mut *mut c_void,
    ) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetPropertyDescriptionList(
        &self,
        _: *const windows::Win32::Foundation::PROPERTYKEY,
        _: *const GUID,
        _: *mut *mut c_void,
    ) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetAttributes(&self, _: SIATTRIBFLAGS, _: SFGAO_FLAGS) -> windows_core::Result<SFGAO_FLAGS> {
        Err(E_NOTIMPL.into())
    }
    fn GetCount(&self) -> windows_core::Result<u32> {
        Ok(self.0.len() as u32)
    }
    fn GetItemAt(&self, index: u32) -> windows_core::Result<IShellItem> {
        self.0
            .get(index as usize)
            .cloned()
            .ok_or_else(|| E_NOTIMPL.into())
    }
    fn EnumItems(&self) -> windows_core::Result<IEnumShellItems> {
        Err(E_NOTIMPL.into())
    }
}

/// A folder view showing `folder`, as Explorer's site serves one.
#[implement(IServiceProvider, IFolderView)]
struct Site(IShellItem);

impl IServiceProvider_Impl for Site_Impl {
    fn QueryService(
        &self,
        service: *const GUID,
        riid: *const GUID,
        object: *mut *mut c_void,
    ) -> windows_core::Result<()> {
        // SAFETY: COM's contract for the three pointers.
        unsafe {
            if *service != IFolderView::IID {
                return Err(E_NOTIMPL.into());
            }
            let view: IFolderView = self.to_interface();
            view.query(riid, object).ok()
        }
    }
}

impl IFolderView_Impl for Site_Impl {
    fn GetCurrentViewMode(&self) -> windows_core::Result<u32> {
        Err(E_NOTIMPL.into())
    }
    fn SetCurrentViewMode(&self, _: u32) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetFolder(&self, riid: *const GUID, object: *mut *mut c_void) -> windows_core::Result<()> {
        // SAFETY: COM's contract for the two pointers.
        unsafe { self.0.query(riid, object) }.ok()
    }
    fn Item(&self, _: i32) -> windows_core::Result<*mut ITEMIDLIST> {
        Err(E_NOTIMPL.into())
    }
    fn ItemCount(&self, _: &_SVGIO) -> windows_core::Result<i32> {
        Err(E_NOTIMPL.into())
    }
    fn Items(&self, _: &_SVGIO, _: *const GUID, _: *mut *mut c_void) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetSelectionMarkedItem(&self) -> windows_core::Result<i32> {
        Err(E_NOTIMPL.into())
    }
    fn GetFocusedItem(&self) -> windows_core::Result<i32> {
        Err(E_NOTIMPL.into())
    }
    fn GetItemPosition(&self, _: *const ITEMIDLIST) -> windows_core::Result<POINT> {
        Err(E_NOTIMPL.into())
    }
    fn GetSpacing(&self, _: *mut POINT) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetDefaultSpacing(&self) -> windows_core::Result<POINT> {
        Err(E_NOTIMPL.into())
    }
    fn GetAutoArrange(&self) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn SelectItem(&self, _: i32, _: u32) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn SelectAndPositionItems(
        &self,
        _: u32,
        _: *const *const ITEMIDLIST,
        _: *const POINT,
        _: u32,
    ) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }
}

/// A temporary directory of this test's own, removed at the end.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        // Under the target directory: a long path, as Explorer gives (the
        // temporary directory may be an 8.3 short name).
        // Its separators as Windows writes them, so paths compare as the DLL
        // and the fake print them.
        let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR").replace('/', "\\"));
        let path = base.join(format!(
            "lasterm-explorer-command-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("create the scratch directory");
        Scratch(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn item(path: &Path) -> IShellItem {
    // SAFETY: plain call; the path is an existing file or directory.
    unsafe { SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None) }
        .unwrap_or_else(|error| panic!("shell item for {}: {error}", path.display()))
}

fn selection(items: &[&Path]) -> IShellItemArray {
    Selection(items.iter().map(|path| item(path)).collect()).into()
}

fn take_string(text: windows_core::PWSTR) -> String {
    // SAFETY: the callee allocated the string with the shell's allocator.
    let value = unsafe { text.to_string() }.expect("UTF-16 string");
    unsafe { CoTaskMemFree(Some(text.0 as *const c_void)) };
    value
}

/// The directory holding this test's executable: cargo puts the crate's
/// cdylib there, and its examples beside it.
fn build_directory() -> PathBuf {
    let exe = std::env::current_exe().expect("current exe");
    exe.parent().expect("deps directory").to_path_buf()
}

/// What `Invoke` is given: a selection of these paths (`Some`, possibly
/// empty) or none, and the folder a site shows, if any.
struct Call {
    items: Option<Vec<PathBuf>>,
    site: Option<PathBuf>,
}

/// Runs `Invoke` on a thread of its own and waits at most 10 s for it, so an
/// `Invoke` that waits for the process it started fails instead of hanging.
/// The shell items are made on that thread: they belong to its apartment.
fn invoke_within_deadline(command: &IExplorerCommand, call: Call) -> windows_core::Result<()> {
    let command_raw = command.as_raw() as usize;
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        // SAFETY: the command is agile (free-threaded); the main thread keeps
        // it alive until this thread has answered or the deadline passed.
        let result = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let command_ptr = command_raw as *mut c_void;
            let command = IExplorerCommand::from_raw_borrowed(&command_ptr).expect("command");
            let with_site: IObjectWithSite = command.cast().expect("IObjectWithSite");
            if let Some(folder) = &call.site {
                let site: IServiceProvider = Site(item(folder)).into();
                with_site.SetSite(&site).expect("SetSite");
            }
            let items: Option<IShellItemArray> = call
                .items
                .as_ref()
                .map(|paths| Selection(paths.iter().map(|path| item(path)).collect()).into());
            let result = command
                .Invoke(items.as_ref(), None::<&IBindCtx>)
                .map_err(|error| error.code());
            with_site.SetSite(None).expect("clear the site");
            result
        };
        let _ = done_tx.send(result);
    });
    match done_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result) => result.map_err(windows_core::Error::from),
        Err(_) => panic!("Invoke did not return within 10 s: it waits for the process it started"),
    }
}

fn wait_for(path: &Path, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    path.exists()
}

#[test]
fn the_built_dll_serves_the_explorer_command() {
    // SAFETY: COM initialisation of this test's thread.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .expect("COM");

    let build = build_directory();
    let scratch = Scratch::new();
    let package = scratch.0.join("package");
    std::fs::create_dir_all(&package).unwrap();
    let dll = package.join("lasterm_explorer_command.dll");
    std::fs::copy(build.join("lasterm_explorer_command.dll"), &dll).expect("copy the built DLL");
    let fake = build.join("../examples/fake-desktop.exe");
    std::fs::copy(&fake, package.join(DESKTOP_EXE)).expect("copy the fake desktop");

    let dir_a = scratch.0.join("dossier é 漢 a");
    let dir_b = scratch.0.join("dir b");
    std::fs::create_dir_all(&dir_a).unwrap();
    std::fs::create_dir_all(&dir_b).unwrap();
    let zip = scratch.0.join("archive.zip");
    // An empty zip archive: its end-of-central-directory record alone.
    let mut empty_zip = b"PK\x05\x06".to_vec();
    empty_zip.extend_from_slice(&[0; 18]);
    std::fs::write(&zip, empty_zip).unwrap();

    // SAFETY: loading the copy, as the surrogate loads the package's DLL.
    let module: HMODULE = unsafe { LoadLibraryW(&HSTRING::from(dll.as_os_str())) }.expect("load");
    let get_class_object: GetClassObject = unsafe {
        std::mem::transmute(
            GetProcAddress(module, PCSTR(c"DllGetClassObject".as_ptr().cast()))
                .expect("DllGetClassObject export"),
        )
    };
    let can_unload_now: CanUnloadNow = unsafe {
        std::mem::transmute(
            GetProcAddress(module, PCSTR(c"DllCanUnloadNow".as_ptr().cast()))
                .expect("DllCanUnloadNow export"),
        )
    };
    assert_eq!(unsafe { can_unload_now() }, S_FALSE);

    let clsid = GUID::try_from(CLSID_TEXT).expect("CLSID");
    let mut factory_raw = std::ptr::null_mut();
    let other = GUID::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
    assert_eq!(
        unsafe { get_class_object(&other, &IClassFactory::IID, &mut factory_raw) },
        CLASS_E_CLASSNOTAVAILABLE
    );
    unsafe { get_class_object(&clsid, &IClassFactory::IID, &mut factory_raw) }
        .ok()
        .expect("class factory");
    let factory = unsafe { IClassFactory::from_raw(factory_raw) };
    let command: IExplorerCommand = unsafe { factory.CreateInstance(None) }.expect("command");

    let expected_title = title_for_language(unsafe { GetUserDefaultUILanguage() });
    assert_eq!(
        take_string(unsafe { command.GetTitle(None) }.unwrap()),
        expected_title
    );
    assert_eq!(
        take_string(unsafe { command.GetIcon(None) }.unwrap()),
        format!("{},0", package.join(DESKTOP_EXE).display())
    );
    assert_eq!(unsafe { command.GetCanonicalName() }.unwrap(), clsid);
    assert_eq!(unsafe { command.GetFlags() }.unwrap(), ECF_DEFAULT.0 as u32);
    assert_eq!(
        unsafe { command.GetToolTip(None) }.unwrap_err().code(),
        E_NOTIMPL
    );
    assert_eq!(
        unsafe { command.EnumSubCommands() }.unwrap_err().code(),
        E_NOTIMPL
    );

    let state =
        |items: Option<&IShellItemArray>| unsafe { command.GetState(items, false) }.unwrap();
    assert_eq!(
        state(Some(&selection(&[&dir_a, &zip]))),
        ECS_ENABLED.0 as u32
    );
    assert_eq!(
        state(Some(&selection(&[&zip, &dir_a]))),
        ECS_HIDDEN.0 as u32
    );
    assert_eq!(state(None), ECS_HIDDEN.0 as u32);

    // What the fake records, and when the test lets it end.
    let record = scratch.0.join("record.txt");
    let release = scratch.0.join("release");
    std::env::set_var("LASTERM_FAKE_DESKTOP_RECORD", &record);
    std::env::set_var("LASTERM_FAKE_DESKTOP_RELEASE", &release);
    let recorded = |record: &Path| -> Vec<String> {
        std::fs::read_to_string(record)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    };
    let reset = |record: &Path, release: &Path| {
        std::fs::write(release, b"").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let _ = std::fs::remove_file(record);
        let _ = std::fs::remove_file(release);
    };

    let paths = |paths: &[&Path]| Call {
        items: Some(paths.iter().map(|path| path.to_path_buf()).collect()),
        site: None,
    };

    // A refused location starts nothing.
    invoke_within_deadline(&command, paths(&[&zip])).expect("Invoke on a zip succeeds");
    assert!(
        !wait_for(&record, Duration::from_secs(2)),
        "a zip started the desktop"
    );

    // An offered folder starts the desktop with it, and Invoke returns while
    // the desktop still runs.
    invoke_within_deadline(&command, paths(&[&dir_a])).expect("Invoke on a folder");
    assert!(
        wait_for(&record, Duration::from_secs(10)),
        "the desktop was not started"
    );
    assert!(!release.exists());
    assert_eq!(
        recorded(&record),
        [
            "--open-folder".to_string(),
            dir_a.display().to_string(),
            package.display().to_string()
        ]
    );
    reset(&record, &release);

    // Several folders: the first one.
    invoke_within_deadline(&command, paths(&[&dir_a, &dir_b])).unwrap();
    assert!(wait_for(&record, Duration::from_secs(10)));
    assert_eq!(recorded(&record)[1], dir_a.display().to_string());
    reset(&record, &release);

    // A background click: no selection, or an empty one, and the site's folder.
    let site: IServiceProvider = Site(item(&dir_b)).into();
    let with_site: IObjectWithSite = command.cast().unwrap();
    unsafe { with_site.SetSite(&site) }.unwrap();
    assert_eq!(state(None), ECS_ENABLED.0 as u32);
    assert_eq!(state(Some(&selection(&[]))), ECS_ENABLED.0 as u32);
    unsafe { with_site.SetSite(None) }.unwrap();
    for items in [None, Some(Vec::new())] {
        invoke_within_deadline(
            &command,
            Call {
                items,
                site: Some(dir_b.clone()),
            },
        )
        .unwrap();
        assert!(wait_for(&record, Duration::from_secs(10)));
        assert_eq!(recorded(&record)[1], dir_b.display().to_string());
        reset(&record, &release);
    }

    // Without the desktop beside the DLL: an offered folder fails, a refused
    // location still succeeds.
    std::fs::remove_file(package.join(DESKTOP_EXE)).unwrap();
    assert!(invoke_within_deadline(&command, paths(&[&dir_a])).is_err());
    invoke_within_deadline(&command, paths(&[&zip])).expect("a zip still succeeds");
}
