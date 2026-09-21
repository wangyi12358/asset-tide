// Only public CoinGecko image hosts are accepted; never arbitrary imported URLs.
export function coinIconUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["coin-images.coingecko.com", "assets.coingecko.com"].includes(
        url.hostname,
      ) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}
