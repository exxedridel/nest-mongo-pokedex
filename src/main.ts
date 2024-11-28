import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      }
    })
  );

  app.setGlobalPrefix('api/v2')

  const PORT = process.env.PORT ?? 3001
  await app.listen(PORT);
  console.log(`\n🆗 App running on PORT: ${PORT}`)
  console.log(`\n🚀 App running over http://localhost:${PORT}/`)
}
bootstrap();
