// Links the app hands to the system to open: only web pages, which open in the browser. Any other scheme
// (file:, smb:, ms-msdt:, search-ms: ...) would let a page in the window, such as the Web Flasher's frame,
// open files or start programs on this computer.
export function isWebLink(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'https:' || protocol === 'http:';
}
