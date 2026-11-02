import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AssignmentModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
