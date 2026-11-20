import { SetMetadata } from '@nestjs/common';

// Every route requires an access token (AccessTokenGuard is global); @Public() is
// the explicit exception. A new route is protected unless someone marks it.
export const IS_PUBLIC = 'auth:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
