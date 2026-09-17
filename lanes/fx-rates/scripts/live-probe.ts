import { LiveFxProvider } from "../src/providers/live.js";
async function main() {
  const provider = new LiveFxProvider();
  for (const country of ["NG", "GH", "KE", "TZ", "ZA", "RW"]) {
    try {
      const rate = await provider.getOfficialRate(country);
      console.log(`${country}:`, JSON.stringify(rate));
    } catch (e) {
      console.log(`${country}: ERROR`, (e as Error).message);
    }
  }
}
main();
