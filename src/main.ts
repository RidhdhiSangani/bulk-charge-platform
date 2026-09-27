import './load-env';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { config } from './config';

/** Shared by the real bootstrap and the integration tests. */
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const doc = new DocumentBuilder()
    .setTitle('Bulk Charge Platform API')
    .setDescription(
      'Entity-agnostic bulk action engine for shipments. Create a job with a filter, then follow it via detail, ' +
        'the live event stream, summary and per-entity entries. Seeded tenants: tnt_demo, tnt_acme. ' +
        'Source, README and Postman collection: see the repository.',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { tryItOutEnabled: true, displayRequestDuration: true },
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port(), '0.0.0.0');
  new Logger('Bootstrap').log(
    `API listening on :${config.port()} (docs at /docs)` +
      (config.runWorkersInApi() ? ' — combined mode: queue workers running in this process' : ''),
  );
}

if (require.main === module) {
  void bootstrap();
}
