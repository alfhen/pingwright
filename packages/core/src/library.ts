// Library loads carry build hashes (fbevents.js asks for signals/config/...?hme=<sha256>). Other script requests can carry hits.
const LIBRARY_PATH = /(?:^|\/)(?:gtag\/js|fbevents\.js|signals\/config\/[^/]*)$/;

export function isLibraryLoadPath(pathname: string): boolean {
  return LIBRARY_PATH.test(pathname);
}
