import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller.js';
import { CommentsService } from './comments.service.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';

@Module({
  controllers: [TicketsController, CommentsController],
  providers: [TicketsService, CommentsService],
})
export class TicketsModule {}
