import { JobEntity } from './job.entity.js';
import { OrderItemEntity } from './order-item.entity.js';
import { OrderEntity } from './order.entity.js';
import { ProductEntity } from './product.entity.js';
import { UserEntity } from './user.entity.js';

export { JobEntity, OrderItemEntity, OrderEntity, ProductEntity, UserEntity };
export { ORDER_STATUSES, type OrderStatus } from './order.entity.js';
export { JOB_STATUSES, type JobStatus } from './job.entity.js';

// Every entity the DataSource registers. An entity missing here is invisible to
// migration:generate, so the list lives next to the classes.
export const entities = [UserEntity, ProductEntity, OrderEntity, OrderItemEntity, JobEntity];
