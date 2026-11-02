import { Module } from '@nestjs/common';
import { SlaPoliciesController } from './sla-policies.controller.js';
import { SlaPoliciesService } from './sla-policies.service.js';

@Module({
  controllers: [SlaPoliciesController],
  providers: [SlaPoliciesService],
})
export class SlaModule {}
