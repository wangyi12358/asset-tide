// Lazy-load the native SDK only when a configured Hong Kong quote is requested.
export const longportSdk = {
  async create(appKey: string, appSecret: string, accessToken: string) {
    const { Config, QuoteContext } = await import("longport");
    return QuoteContext.new(
      Config.fromApikey(appKey, appSecret, accessToken, {
        enablePrintQuotePackages: false,
      }),
    );
  },
};
