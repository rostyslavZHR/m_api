import { Check, Column, DeleteDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// The lower(name) index and its CREATE STATISTICS aren't here: TypeORM can't
// describe an index on an expression, so they live in hand-written migration
// SQL. TypeORM doesn't see them either, so they never show up in a diff.
@Entity('products')
@Check('products_price_cents_check', 'price_cents >= 0')
export class ProductEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string; // bigint → string in pg

  @Column('text')
  name: string;

  @Column('text')
  description: string;

  // Integer minor units (cents): 349900 = 3499.00. pg returns bigint as a
  // string, so no precision is lost in JS.
  @Column('bigint', { name: 'price_cents' })
  priceCents: string;

  @Column('boolean', { name: 'in_stock', default: false })
  inStock: boolean;

  // Soft delete: repo.softRemove() sets it, and find() skips rows where it's set.
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt: Date | null;

  // Declared here rather than hand-written: TypeORM looks up every generated
  // column it finds in the DB in its typeorm_metadata table, which only exists
  // if TypeORM created the column. The generated migration creates both.
  @Index('products_search_vector_idx', { type: 'gin', where: 'deleted_at IS NULL' })
  // generatedType/asExpression exist only in the full-options overload.
  @Column({
    type: 'tsvector',
    name: 'search_vector',
    nullable: true,
    generatedType: 'STORED',
    asExpression: `to_tsvector('simple', name || ' ' || description)`,
    select: false,
    insert: false,
    update: false,
  })
  searchVector: string;
}
