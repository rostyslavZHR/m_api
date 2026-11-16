// Seeded rows that other scripts look up by natural key. Here, not in seed.ts:
// importing seed.ts would run the seed (it executes on load).

// For the insufficient-funds check: a user who can't afford anything.
export const BROKE_USER_EMAIL = 'broke@example.com';

// Every main seeded user's balance: far more than any checkout costs, so in the
// race demo stock is the only limit. The race demo resets its buyer to it.
export const USER_BALANCE_CENTS = 100_000_000; // 1,000,000.00

// The race demo's buyer — one of the users seeded with USER_BALANCE_CENTS.
export const RACE_BUYER_EMAIL = 'user1@example.com';

// The retry demo's subject — a seeded user no other demo touches. The demo
// resets it to this balance first, so every run starts identically.
export const RETRY_USER_EMAIL = 'user2@example.com';
export const RETRY_START_BALANCE_CENTS = 100_000; // 1,000.00

// For the oversell race.
export const RACE_PRODUCT = {
  name: 'Race product',
  description: 'Limited stock, for the concurrent checkout demo',
  priceCents: 1000, // 10.00
  stock: 10,
};
