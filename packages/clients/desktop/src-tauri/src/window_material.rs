//! What the window itself must be for a background to show.
//!
//! Two shapes, and they cannot be the same window:
//!
//! - **Alpha** — created `transparent`, so the desktop shows through whatever
//!   the page leaves unpainted. This is see-through, and on macOS it is also
//!   what the vibrancy materials are drawn into.
//! - **Material** — created opaque, with the webview's own background cleared,
//!   so DWM paints Mica or Acrylic behind the page. Windows draws these
//!   materials for a window, and skips a window that carries per-pixel alpha:
//!   asking for both is how mica, acrylic and blur ended up indistinguishable
//!   and none of them see-through (#62).
//!
//! `transparent` is fixed when a window is created, so moving between the two
//! rebuilds the main window rather than restarting the app.

/// The shape a window must have for the background the user asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowSurface {
    /// Created transparent: the page's own alpha reaches the desktop.
    Alpha,
    /// Created opaque: DWM paints its material behind a cleared webview.
    Material,
}

/// The effect names the web client resolves to, as it sends them.
pub const EFFECT_NONE: &str = "none";

/// Whether an effect is one of the Windows materials DWM paints for a window.
fn is_windows_material(effect: &str) -> bool {
    matches!(effect, "mica" | "micaDark" | "micaLight" | "tabbed" | "acrylic")
}

/// The surface an effect needs on this platform.
///
/// macOS vibrancy is drawn into a transparent window, so only the Windows
/// materials move the window off its alpha surface.
pub fn surface_for(effect: &str, on_windows: bool) -> WindowSurface {
    if on_windows && is_windows_material(effect) {
        WindowSurface::Material
    } else {
        WindowSurface::Alpha
    }
}

/// The surface an effect needs on the platform this binary was built for.
pub fn surface_for_host(effect: &str) -> WindowSurface {
    surface_for(effect, cfg!(windows))
}

/// Whether moving to this background has to wait for the next launch.
///
/// A window is built see-through or built for a material, and which it is
/// cannot change under a running app: `transparent` is settled at creation.
pub fn needs_restart(from: &str, to: &str, on_windows: bool) -> bool {
    surface_for(from, on_windows) != surface_for(to, on_windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sees_through_when_no_effect_is_asked_for() {
        assert_eq!(surface_for(EFFECT_NONE, true), WindowSurface::Alpha);
        assert_eq!(surface_for(EFFECT_NONE, false), WindowSurface::Alpha);
    }

    #[test]
    fn windows_materials_need_a_window_dwm_will_paint() {
        for effect in ["mica", "micaDark", "micaLight", "tabbed", "acrylic"] {
            assert_eq!(surface_for(effect, true), WindowSurface::Material, "{effect}");
        }
    }

    // Blur is the legacy accent, drawn into the window rather than behind it,
    // and it is the one effect that still composes with per-pixel alpha.
    #[test]
    fn blur_stays_on_the_alpha_surface() {
        assert_eq!(surface_for("blur", true), WindowSurface::Alpha);
    }

    #[test]
    fn macos_vibrancy_is_drawn_into_a_transparent_window() {
        for effect in ["underWindowBackground", "sidebar", "hudWindow"] {
            assert_eq!(surface_for(effect, false), WindowSurface::Alpha, "{effect}");
        }
    }

    #[test]
    fn a_material_asked_for_from_see_through_waits_for_the_next_launch() {
        assert!(needs_restart(EFFECT_NONE, "acrylic", true));
        assert!(needs_restart("mica", EFFECT_NONE, true));
    }

    #[test]
    fn one_material_for_another_lands_at_once() {
        assert!(!needs_restart("mica", "acrylic", true));
        assert!(!needs_restart("acrylic", "tabbed", true));
    }

    // Nothing moves the window off its surface there, so nothing waits.
    #[test]
    fn no_background_waits_for_a_launch_away_from_windows() {
        assert!(!needs_restart(EFFECT_NONE, "underWindowBackground", false));
        assert!(!needs_restart(EFFECT_NONE, "acrylic", false));
    }

    // A name this build does not know must not strand the window opaque.
    #[test]
    fn an_unknown_effect_leaves_the_window_as_it_was() {
        assert_eq!(surface_for("something-else", true), WindowSurface::Alpha);
    }
}
