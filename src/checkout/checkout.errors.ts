// Expected business rejections, as types: the race demo tells them apart from
// real failures with instanceof. Throwing either inside the checkout transaction
// also rolls back everything before it.

export class OutOfStockError extends Error {
  constructor(
    readonly productId: string,
    readonly quantity: number,
  ) {
    // Also covers a missing or soft-deleted product: the guarded update can't
    // tell those apart from too little stock, and none of them can be sold.
    super(`Product ${productId}: not enough stock for ${quantity}, or not available`);
    this.name = 'OutOfStockError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    readonly userId: string,
    readonly totalCents: bigint,
  ) {
    // Also covers a user who doesn't exist: the guarded update returns zero rows
    // either way.
    super(`User ${userId}: balance doesn't cover ${totalCents} cents`);
    this.name = 'InsufficientFundsError';
  }
}
