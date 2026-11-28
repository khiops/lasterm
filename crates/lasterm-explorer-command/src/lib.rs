//! File Explorer's **Open in lasterm** command (#1236).
//!
//! The MSIX package registers this library as a COM server run by its
//! surrogate (`com:SurrogateServer`) and declares the class as a context-menu
//! verb on folders and folder backgrounds (`desktop4:FileExplorerContextMenus`).
//! Choosing the entry starts the package's desktop with `--open-folder <path>`;
//! the desktop hands the folder to a running Lasterm or starts one.
//!
//! [`rule`] holds the decisions shared with the desktop and builds everywhere.
//! The COM class (feature `com`, Windows only) is the rest.

pub mod rule;

#[cfg(test)]
mod package_name;

#[cfg(all(windows, feature = "com"))]
mod com;

/// The class's CLSID, as the package manifest writes it.
pub const CLSID_TEXT: &str = "990fe47e-094a-4386-8446-81c6b0d971ca";

/// The file the package manifest registers as the class's server.
pub const DLL_FILE_NAME: &str = "lasterm_explorer_command.dll";

/// The desktop executable beside the DLL in the package, which `Invoke`
/// starts: the desktop crate's package name (build.rs).
pub const DESKTOP_EXE: &str = env!("LASTERM_DESKTOP_EXE");

#[cfg(test)]
mod tests {
    use super::*;

    const COM: &str = "http://schemas.microsoft.com/appx/manifest/com/windows10";
    const DESKTOP4: &str = "http://schemas.microsoft.com/appx/manifest/desktop/windows10/4";
    const DESKTOP5: &str = "http://schemas.microsoft.com/appx/manifest/desktop/windows10/5";
    const FOUNDATION: &str = "http://schemas.microsoft.com/appx/manifest/foundation/windows10";

    fn children<'a, 'input>(
        node: roxmltree::Node<'a, 'input>,
        namespace: &'a str,
        name: &'a str,
    ) -> impl Iterator<Item = roxmltree::Node<'a, 'input>> + 'a {
        node.children()
            .filter(move |child| child.has_tag_name((namespace, name)))
    }

    fn only<'a, 'input>(
        node: roxmltree::Node<'a, 'input>,
        namespace: &'a str,
        name: &'a str,
    ) -> roxmltree::Node<'a, 'input> {
        let found: Vec<_> = children(node, namespace, name).collect();
        assert_eq!(
            found.len(),
            1,
            "exactly one {name} under {:?}",
            node.tag_name()
        );
        found[0]
    }

    #[test]
    fn the_package_manifest_registers_this_class_for_folders() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/clients/desktop/msix/Package.appxmanifest"
        );
        let text = std::fs::read_to_string(path).expect("read the package manifest");
        let document = roxmltree::Document::parse(&text).expect("parse the package manifest");
        let package = document.root_element();
        assert!(package.has_tag_name((FOUNDATION, "Package")));

        let mut ignorable: Vec<&str> = package
            .attribute("IgnorableNamespaces")
            .expect("IgnorableNamespaces")
            .split_whitespace()
            .collect();
        ignorable.sort_unstable();
        assert_eq!(
            ignorable,
            ["com", "desktop", "desktop4", "desktop5", "rescap", "uap", "uap10", "uap3"]
        );

        let application = only(
            only(package, FOUNDATION, "Applications"),
            FOUNDATION,
            "Application",
        );
        let extensions = only(application, FOUNDATION, "Extensions");

        let com_servers: Vec<_> = children(extensions, COM, "Extension")
            .filter(|extension| extension.attribute("Category") == Some("windows.comServer"))
            .collect();
        assert_eq!(com_servers.len(), 1);
        let surrogate = only(
            only(com_servers[0], COM, "ComServer"),
            COM,
            "SurrogateServer",
        );
        assert_eq!(
            surrogate.attribute("DisplayName"),
            Some("Lasterm Explorer command")
        );
        let class = only(surrogate, COM, "Class");
        assert_eq!(class.attribute("Id"), Some(CLSID_TEXT));
        assert_eq!(class.attribute("Path"), Some(DLL_FILE_NAME));
        assert_eq!(class.attribute("ThreadingModel"), Some("STA"));

        let menus: Vec<_> = children(extensions, DESKTOP4, "Extension")
            .filter(|extension| {
                extension.attribute("Category") == Some("windows.fileExplorerContextMenus")
            })
            .collect();
        assert_eq!(menus.len(), 1);
        let menus = only(menus[0], DESKTOP4, "FileExplorerContextMenus");
        let item_types: Vec<_> = children(menus, DESKTOP5, "ItemType").collect();
        let types: Vec<_> = item_types
            .iter()
            .map(|item_type| item_type.attribute("Type").expect("ItemType Type"))
            .collect();
        assert_eq!(types, ["Directory", "Directory\\Background"]);
        for item_type in item_types {
            let verb = only(item_type, DESKTOP5, "Verb");
            assert_eq!(verb.attribute("Id"), Some("OpenInLasterm"));
            assert_eq!(verb.attribute("Clsid"), Some(CLSID_TEXT));
        }
    }
}
