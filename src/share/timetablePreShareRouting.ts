export const isTimetablePreShareHash = (hash: string): boolean =>
  hash === '#share' || hash.startsWith('#share=')
