import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '../auth/access-tokens';
import { CurrentPrincipal } from '../auth/guards';
import { FilesService, type FileView, type UploadIntent, type UploadParts } from './files.service';

/** Тіло intent у формі схеми `UploadIntentRequest`; форму вже перевірив валідатор спеки. */
interface IntentBody {
  /** Приймається, бо його шле кожен клієнт, — і ніде не використовується: ні в ключі, ні в базі. */
  filename?: string;
  content_type: string;
  size: number;
}

/**
 * Маршрути файлів (#26). Усі під глобальним AuthGuard (#24): анонім отримує
 * 401 ще до обробника. Відповіді з presigned URL позначені `no-store`: URL —
 * це носій доступу до кінця строку, і йому не місце в кеші браузера чи проксі.
 */
@Controller()
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** 200, а не 201: файла ще немає — є лише дозвіл його покласти. */
  @Post('uploads/intent')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  intent(
    @CurrentPrincipal() principal: Principal,
    @Body() body: IntentBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<UploadIntent> {
    return this.files.intent(principal, { contentType: body.content_type, size: body.size, idempotencyKey });
  }

  @Get('uploads/:fileId/parts')
  @Header('Cache-Control', 'no-store')
  parts(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string): Promise<UploadParts> {
    return this.files.parts(principal, fileId);
  }

  @Post('uploads/:fileId/commit')
  @HttpCode(200)
  commit(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string): Promise<FileView> {
    return this.files.commit(principal, fileId);
  }

  /** 302 на presigned GET на хвилину. Свіжий на кожен запит, тож `no-store`. */
  @Get('files/:fileId')
  async download(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string, @Res() res: Response): Promise<void> {
    const url = await this.files.downloadUrl(principal, fileId);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
  }
}
