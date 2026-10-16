// boot: routes, cross-section wiring, shortcuts, service worker

import { $, router, server } from "./core.js";
import { initPlaylist, onSendToBass } from "./playlist.js";
import { initBass, enterBassHome, enterSong, leaveSong, submitLink } from "./bass.js";

router.add(/^#\/?$/, "playlist", () => { leaveSong(); document.title = "Encore"; });
router.add(/^#\/breakdown\/?$/, "bass", () => enterBassHome());
router.add(/^#\/breakdown\/(\w+)$/, "song", (id) => enterSong(id));
// older links (ngulik, bass section, delve)
router.add(/^#\/(?:bass|ngulik)\/?$/, "bass", () => router.go("#/breakdown"));
router.add(/^#\/(?:ngulik|bass\/song|song)\/(\w+)$/, "song", (id) => router.go(`#/breakdown/${id}`));

onSendToBass((url, title) => submitLink(url, title));
$("#shortcutsBtn").onclick = () => $("#shortcuts").showModal();

initBass();
initPlaylist();
// the bass pages depend on the local server, so learn whether it is there before routing
server.check().then(() => router.resolve());

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
