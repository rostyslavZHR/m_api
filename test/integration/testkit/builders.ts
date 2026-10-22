import type { Repository } from 'typeorm';
import type { ProductEntity, UserEntity } from '../../../src/entities/index.js';
import type { NewOrder, OrdersRepository } from '../../../src/orders/orders.repository.js';
import type { NewProduct, ProductsRepository } from '../../../src/products/products.repository.js';

type NewUser = Pick<UserEntity, 'email' | 'balanceCents'>;
type UserRef = Pick<UserEntity, 'id'>;
type ProductRef = Pick<ProductEntity, 'id' | 'name' | 'priceCents'>;

// A counter, never random values, so a failing test reproduces.
let lastSequence = 0;
const nextSequence = () => ++lastSequence;

class ProductBuilder {
  private readonly product: NewProduct;

  constructor(sequence: number) {
    this.product = {
      name: `Product ${sequence}`,
      description: `Test product ${sequence}`,
      priceCents: '1000',
      stock: 10,
    };
  }

  withStock(stock: number) {
    this.product.stock = stock;
    return this;
  }

  withPriceCents(priceCents: string) {
    this.product.priceCents = priceCents;
    return this;
  }

  build(): NewProduct {
    return { ...this.product };
  }

  insertVia(products: ProductsRepository) {
    return products.insert(this.build());
  }
}

class UserBuilder {
  private readonly user: NewUser;

  constructor(sequence: number) {
    this.user = { email: `user-${sequence}@example.com`, balanceCents: '100000' };
  }

  withEmail(email: string) {
    this.user.email = email;
    return this;
  }

  withBalanceCents(balanceCents: string) {
    this.user.balanceCents = balanceCents;
    return this;
  }

  build(): NewUser {
    return { ...this.user };
  }

  insertVia(users: Repository<UserEntity>) {
    return users.save(users.create(this.build()));
  }
}

class OrderBuilder {
  private productId: string;
  private quantity = 1;

  constructor(
    private readonly user: UserRef,
    private readonly product: ProductRef,
  ) {
    this.productId = product.id;
  }

  withQuantity(quantity: number) {
    this.quantity = quantity;
    return this;
  }

  withProductId(productId: string) {
    this.productId = productId;
    return this;
  }

  build(): NewOrder {
    return {
      userId: this.user.id,
      status: 'paid',
      totalCents: (BigInt(this.product.priceCents) * BigInt(this.quantity)).toString(),
      items: [
        {
          productId: this.productId,
          quantity: this.quantity,
          unitPriceCents: this.product.priceCents,
          productName: this.product.name,
        },
      ],
    };
  }

  insertVia(orders: OrdersRepository) {
    return orders.insert(this.build());
  }
}

export const aProduct = () => new ProductBuilder(nextSequence());
export const aUser = () => new UserBuilder(nextSequence());
export const anOrder = (user: UserRef, product: ProductRef) => new OrderBuilder(user, product);
