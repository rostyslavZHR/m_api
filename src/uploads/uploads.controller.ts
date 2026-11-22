import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/tokens.js';
import { type UploadIntentRequest, UploadsService } from './uploads.service.js';

// Both routes need an access token (the global guard): an upload always belongs to the
// caller. 200 rather than Nest's default 201 for a POST: intent creates only a pending
// row and a URL, and commit is idempotent.
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('intent')
  @HttpCode(200)
  intent(@CurrentUser() user: AuthUser, @Body() body: UploadIntentRequest) {
    return this.uploads.intent(user, body);
  }

  @Post('commit')
  @HttpCode(200)
  commit(@CurrentUser() user: AuthUser, @Body() { fileId }: { fileId: string }) {
    return this.uploads.commit(user, fileId);
  }
}
