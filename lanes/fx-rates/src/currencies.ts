/**
 * Currency registry — the v1 bank list from the spec, plus the countries covered by the
 * core FxProvider interface. Egypt (CBE) is v1 but scaffolded TBD: its official source is
 * present (mock + Frankfurter cross-check) but the direct CBE scrape is unconfirmed — the
 * spec forbids scaffolding a scraper against an unconfirmed URL, so CBE ships mock-only
 * until its page/selector is verified at review time.
 */
export interface BankConfig {
  country: string; // ISO-2
  currency: string; // ISO-4217
  bank: string;
  coverage: "v1" | "expansion";
  officialAvailable: boolean;
  parallelAvailable: boolean;
  /** Normal daily publish cadence in local time, for staleness reasoning. */
  publishCadence: "daily" | "three_daily" | "weekly";
}

export const BANKS: BankConfig[] = [
  {
    country: "NG",
    currency: "NGN",
    bank: "Central Bank of Nigeria (CBN)",
    coverage: "v1",
    officialAvailable: true,
    parallelAvailable: true,
    publishCadence: "daily",
  },
  {
    country: "GH",
    currency: "GHS",
    bank: "Bank of Ghana (BoG)",
    coverage: "v1",
    officialAvailable: true,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "KE",
    currency: "KES",
    bank: "Central Bank of Kenya (CBK)",
    coverage: "v1",
    officialAvailable: true,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "ZA",
    currency: "ZAR",
    bank: "South African Reserve Bank (SARB)",
    coverage: "v1",
    officialAvailable: true,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "TZ",
    currency: "TZS",
    bank: "Bank of Tanzania (BoT)",
    coverage: "v1",
    officialAvailable: true,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "RW",
    currency: "RWF",
    bank: "National Bank of Rwanda (BNR)",
    coverage: "v1",
    officialAvailable: true,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "EG",
    currency: "EGP",
    bank: "Central Bank of Egypt (CBE)",
    coverage: "v1",
    // CBE direct scrape TBD (source page unconfirmed) — mock/Frankfurter only for now.
    officialAvailable: true,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "UG",
    currency: "UGX",
    bank: "Bank of Uganda (BoU)",
    coverage: "expansion",
    officialAvailable: false,
    parallelAvailable: false,
    publishCadence: "three_daily",
  },
  {
    country: "ZM",
    currency: "ZMW",
    bank: "Bank of Zambia (BoZ)",
    coverage: "expansion",
    officialAvailable: false,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "MA",
    currency: "MAD",
    bank: "Bank Al-Maghrib (BAM)",
    coverage: "expansion",
    officialAvailable: false,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "ET",
    currency: "ETB",
    bank: "National Bank of Ethiopia (NBE)",
    coverage: "expansion",
    officialAvailable: false,
    parallelAvailable: false,
    publishCadence: "daily",
  },
  {
    country: "BJ",
    currency: "XOF",
    bank: "Banque Centrale des États de l'Afrique de l'Ouest (BCEAO)",
    coverage: "expansion",
    officialAvailable: false,
    parallelAvailable: false,
    publishCadence: "daily",
  },
];

export function bankFor(country: string): BankConfig | undefined {
  return BANKS.find((b) => b.country === country.trim().toUpperCase());
}