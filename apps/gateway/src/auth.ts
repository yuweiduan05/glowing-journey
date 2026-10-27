/**
 * 鉴权与数据边界（对应 1.2「客户身份由网关鉴权注入，模型无权指定他人客户号」）
 *
 * 演示环境用固定 token → customer_id 映射；生产可替换为 JWT 校验，
 * 但「customer_id 只来自凭证、永不来自模型参数」这条约束必须保留。
 */
import { AppError } from '@app/shared';
import type { FastifyRequest } from 'fastify';
import { config } from './env.js';

export interface Caller {
  customerId: string;
  token: string;
}

export function resolveCaller(req: FastifyRequest): Caller {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

  if (!bearer) {
    throw new AppError('UNAUTHORIZED', {
      message: '缺少 Authorization: Bearer <token>',
    });
  }

  const customerId = config.authTokens.get(bearer);
  if (!customerId) {
    throw new AppError('UNAUTHORIZED', { message: '凭证无效或已过期' });
  }

  return { customerId, token: bearer };
}
