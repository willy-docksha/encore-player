// where the encore app builds are downloaded from (github releases, see .github/workflows/release.yml).
// breakdown only runs inside the app; the web version shows this download page instead.
export const APP_RELEASES = "https://github.com/willy-docksha/encore-player/releases/latest";
export const APP_FILES = {
  mac: { file: "Encore-macOS.dmg", label: "macOS", need: "Mac dengan chip Apple (M1 ke atas), macOS 12+" },
  windows: { file: "Encore-Windows.zip", label: "Windows", need: "Windows 10/11, 64-bit, RAM 8 GB+" },
  linux: { file: "Encore-Linux.tar.gz", label: "Linux", need: "Ubuntu 22.04+ atau sejenisnya, 64-bit, RAM 8 GB+" },
};
