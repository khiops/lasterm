import "./styles/base.css";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import "@xterm/xterm/css/xterm.css";
import { useThemeStore } from "./stores/theme.js";
import { installFileDropGuard } from "./utils/file-drop-guard.js";

// Before anything can be dropped: a file dropped where nothing takes it must
// not be opened, which on the desktop broke Tauri's IPC for the page (#822).
installFileDropGuard();

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

// Apply the default bundled theme before any component mounts
// so CSS variables are populated immediately.
const themeStore = useThemeStore(pinia);
themeStore.initialize();

app.mount("#app");
