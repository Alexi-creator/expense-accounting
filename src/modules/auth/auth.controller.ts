import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './auth.constants';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

@Throttle({ default: { ttl: 60_000, limit: 10 } })
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Public()
  @ApiOperation({ summary: 'Register with email and password' })
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: FastifyReply) {
    const tokens = await this.authService.register(dto);
    this.setTokenCookies(res, tokens.accessToken, tokens.refreshToken);
    return { success: true };
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: FastifyReply) {
    const tokens = await this.authService.login(dto);
    this.setTokenCookies(res, tokens.accessToken, tokens.refreshToken);
    return { success: true };
  }

  @Post('google')
  @Public()
  @ApiOperation({ summary: 'Login via Google ID token' })
  async loginGoogle(@Body() dto: GoogleAuthDto, @Res({ passthrough: true }) res: FastifyReply) {
    const tokens = await this.authService.loginWithGoogle(dto);
    this.setTokenCookies(res, tokens.accessToken, tokens.refreshToken);
    return { success: true };
  }

  @Post('telegram')
  @Public()
  @ApiOperation({ summary: 'Login via Telegram Login Widget' })
  async loginTelegram(@Body() dto: TelegramAuthDto, @Res({ passthrough: true }) res: FastifyReply) {
    const tokens = await this.authService.loginWithTelegram(dto);
    this.setTokenCookies(res, tokens.accessToken, tokens.refreshToken);
    return { success: true };
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using refresh token cookie' })
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) throw new UnauthorizedException('No refresh token');

    const tokens = await this.authService.refresh(refreshToken);
    this.setTokenCookies(res, tokens.accessToken, tokens.refreshToken);
    return { success: true };
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout — delete refresh token' })
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (refreshToken) await this.authService.logout(refreshToken);
    res.clearCookie(ACCESS_COOKIE);
    res.clearCookie(REFRESH_COOKIE);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)

  @ApiOperation({ summary: 'Get current user' })
  me(@CurrentUser() user: { id: string }) {
    return user;
  }

  @Post('link/google')
  @UseGuards(JwtAuthGuard)

  @ApiOperation({ summary: 'Link Google to account' })
  linkGoogle(@CurrentUser() user: { id: string }, @Body() dto: GoogleAuthDto) {
    return this.authService.linkGoogle(user.id, dto);
  }

  @Post('link/telegram')
  @UseGuards(JwtAuthGuard)

  @ApiOperation({ summary: 'Link Telegram to account' })
  linkTelegram(@CurrentUser() user: { id: string }, @Body() dto: TelegramAuthDto) {
    return this.authService.linkTelegram(user.id, dto);
  }

  private setTokenCookies(res: FastifyReply, accessToken: string, refreshToken: string) {
    const secure = process.env.NODE_ENV === 'production';
    res.setCookie(ACCESS_COOKIE, accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });
    res.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }
}
