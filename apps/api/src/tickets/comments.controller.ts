import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { CommentDto } from '@support-flow/shared';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { RequestUser } from '../auth/auth.types.js';
import { CommentsService } from './comments.service.js';
import { CreateCommentDto } from './tickets.dto.js';

@Controller('tickets/:id/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) ticketId: string,
  ): Promise<CommentDto[]> {
    return this.comments.list(user, ticketId);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) ticketId: string,
    @Body() dto: CreateCommentDto,
  ): Promise<CommentDto> {
    return this.comments.create(user, ticketId, dto);
  }
}
