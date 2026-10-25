declare module 'webtorrent' { const W: any; namespace W { type Instance = any }; export default W }
declare module 'bittorrent-tracker' { export const Server: any }
// The player's own modules are plain browser ES modules, served as they are; only what a test imports needs a shape.
declare module '*/playclock.js' {
  export function holdsDataAt(v: any, t: number): boolean
  export function isPlaying(v: any): boolean
}
