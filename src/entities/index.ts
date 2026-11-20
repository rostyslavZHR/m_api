import { JobEntity } from './job.entity.js';
import { OrderItemEntity } from './order-item.entity.js';
import { OrderEntity } from './order.entity.js';
import { ProductEntity } from './product.entity.js';
import { UserEntity } from './user.entity.js';
import { OrderEventEntity } from './order-event.entity.js';
import { InvoiceEntity } from './invoice.entity.js';
import { OutboxEntity } from './outbox.entity.js';
import { ProcessedMessageEntity } from './processed-message.entity.js';
import { IdempotencyKeyEntity } from './idempotency-key.entity.js';
import { InvoiceEmailEntity } from './invoice-email.entity.js';

export { JobEntity, OrderItemEntity, OrderEntity, ProductEntity, UserEntity, OrderEventEntity, InvoiceEntity, OutboxEntity, ProcessedMessageEntity, IdempotencyKeyEntity, InvoiceEmailEntity };
export { ORDER_STATUSES, type OrderStatus } from './order.entity.js';
export { JOB_STATUSES, type JobStatus } from './job.entity.js';

// Every entity the DataSource registers. An entity missing here is invisible to
// migration:generate, so the list lives next to the classes.
export const entities = [UserEntity, ProductEntity, OrderEntity, OrderItemEntity, JobEntity, OrderEventEntity, InvoiceEntity, OutboxEntity, ProcessedMessageEntity, IdempotencyKeyEntity, InvoiceEmailEntity];
