import { Controller, Get, Header, Param, Redirect } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/tokens.js';
import { UploadsService } from './uploads.service.js';

// Downloads (#182): every request goes through the global guard and the owner check, then
// gets a 302 to a fresh 60-second presigned GET. Without the guard, file ids would be
// public links; with a long-lived URL handed out instead, access couldn't be taken back.
@Controller('files')
export class FilesController {
  constructor(private readonly uploads: UploadsService) {}

  // no-store on the 302 itself: its Location holds a bearer URL, so no browser or shared
  // cache may keep it and replay it, to this user later or to someone else.
  @Get(':id')
  @Redirect(undefined, 302)
  @Header('Cache-Control', 'no-store')
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return { url: await this.uploads.downloadUrl(user, id) };
  }
}
