import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ENV, type Env } from './config/env.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule);
const env = app.get<Env>(ENV);
configureApp(app, env);
app.enableShutdownHooks();

await app.listen(env.PORT, '0.0.0.0');
