export const createCloudAuthRedirectUrl = (currentHref: string): string => {
  const currentUrl = new URL(currentHref)
  return new URL('/', currentUrl.origin).toString()
}
