export type RichListCategory =
  | "Foundation"
  | "InFlux"
  | "Swap Pool"
  | "Coinbase Pool"
  | "Listing"
  | "Mining"
  | "Community"
  | "Ecosystem"
  | "Exchange"
  | "Shared Nodes"
  | "Cumulus Nodes"
  | "Nimbus Nodes"
  | "Stratus Nodes"
  | "Unknown"
  | "Other";

export interface RichListLabelDefinition {
  address: string;
  label: string;
  category: RichListCategory;
  note?: string;
  locked?: boolean;
}

export const richListLabels: RichListLabelDefinition[] = [
  {
    address: "t3c51GjrkUg7pUiS8bzNdTnW2hD25egWUih",
    label: "Reserve",
    category: "InFlux",
    locked: true,
  },
  {
    address: "t3ZQQsd8hJNw6UQKYLwfofdL3ntPmgkwofH",
    label: "FluxNode Operations",
    category: "InFlux",
  },
  {
    address: "t3XjYMBvwxnXVv9jqg4CgokZ3f7kAoXPQL8",
    label: "Reserve",
    category: "InFlux",
    locked: true,
  },
  {
    address: "t1XWTigDqS5Dy9McwQc752ShtZV1ffTMJB3",
    label: "Operational funds",
    category: "InFlux",
  },
  {
    address: "t1eabPBaLCqNgttQMnAoohPaQM6u2vFwTNJ",
    label: "Operational funds",
    category: "InFlux",
  },
  {
    address: "t1gZgxSEr9RcMBcUyHvkN1U2bJsz3CEV2Ve",
    label: "Mining rewards",
    category: "InFlux",
  },
  {
    address: "t3hPu1YDeGUCp8m7BQCnnNUmRMJBa5RadyA",
    label: "Block rewards",
    category: "InFlux",
  },
  {
    address: "t3PMbbA5YBMrjSD3dD16SSdXKuKovwmj6tS",
    label: "Flux Listing",
    category: "Listing",
    locked: true,
  },
  {
    address: "t1abAp9oZenibGLFuZKyUjmL6FiATTaCYaj",
    label: "Flux Swap Pool",
    category: "Swap Pool",
    note: "Hot wallet",
  },
  {
    address: "t1cjcLaDHkNcuXh6uoyNL7u1jx7GxvzfYAN",
    label: "Flux Swap Pool",
    category: "Swap Pool",
    note: "Cold storage",
  },
  {
    address: "t3ThbWogDoAjGuS6DEnmN1GWJBRbVjSUK4T",
    label: "Flux Swap Pool",
    category: "Swap Pool",
    locked: true,
  },
  {
    address: "t3heoBJT9gn9mne7Q5aynajJo7tReyDv2NV",
    label: "Flux Swap Pool",
    category: "Swap Pool",
    locked: true,
  },
  {
    address: "t1ZLpyVr6hs3vAH7qKujJRpu17G3VdxAkrY",
    label: "Flux Swap Pool",
    category: "Swap Pool",
    note: "Cold storage",
  },
  {
    address: "t1SHUuYiE8UT7Hnu9Qr3QcGu3W4L55W98pU",
    label: "Flux Swap Pool",
    category: "Swap Pool",
    note: "Hot wallet",
  },
  {
    address: "t1Yum7okNzR5kW84dfgwqB23yy1BCcpHFPq",
    label: "Flux Coinbase Pool",
    category: "Swap Pool",
    note: "Hot wallet",
  },
  {
    address: "t1Zj9vUsAMoG4M9LSy5ahDzZUmokKGXqwcT",
    label: "Flux Coinbase Pool",
    category: "Coinbase Pool",
    note: "Hot wallet",
  },
  {
    address: "t1bLYKTWBMUSAhrU2ezDEzC2BXYbafz5L9e",
    label: "CoinEX Exchange",
    category: "Exchange",
    note: "Hot wallet",
  },
  {
    address: "t1YvimnGBmVA7xDiPnqwbKsvujmSJz4X5m2",
    label: "Gate.io Exchange",
    category: "Exchange",
    note: "Hot wallet",
  },
  {
    address: "t1g7QCktktwReoHgwWtAgNBVvzzboQVZy19",
    label: "KuCoin Exchange",
    category: "Exchange",
    note: "Hot wallet",
  },
  {
    address: "t1gorwQHhWsvfgSEE3YzBZFnyewfGaimUbF",
    label: "KuCoin Exchange",
    category: "Exchange",
    note: "Cold wallet",
  },
  {
    address: "t3c4EfxLoXXSRZCRnPRF3RpjPi9mBzF5yoJ",
    label: "Titan",
    category: "Shared Nodes",
  },
  {
    address: "t3gCppaQdKhCViBA2mtYMphmJmtKY4BbR7d",
    label: "FluxNode Operations",
    category: "InFlux",
  },
  {
    address: "t1enVJqsiqRxpdnQw3f6Zwp1jAk9e3Wj9n2",
    label: "FluxNode Operations",
    category: "InFlux",
  },
  {
    address: "t1PGMqZxGPzPQcpJKWVyLc4c9D7SvjVe4kq",
    label: "FluxNode Operations",
    category: "InFlux",
  },
];

export const richListLabelMap = new Map(
  richListLabels.map((entry) => [entry.address, entry])
);

export const richListCategoryColors: Record<string, string> = {
  Foundation: "#3b82f6",
  InFlux: "#f87171",
  "Swap Pool": "#f97316",
  "Coinbase Pool": "#ec4899",
  Listing: "#a855f7",
  Mining: "#22c55e",
  Community: "#06b6d4",
  Ecosystem: "#14b8a6",
  Exchange: "#f59e0b",
  "Shared Nodes": "#10b981",
  "Cumulus Nodes": "#ec4899",
  "Nimbus Nodes": "#a855f7",
  "Stratus Nodes": "#3b82f6",
  Unknown: "#9ca3af",
  Other: "#6b7280",
};
