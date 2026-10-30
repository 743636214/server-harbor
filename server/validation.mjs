import { z } from 'zod';
import { isIP } from 'node:net';
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (v) => isIP(v) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(v),
    '请输入有效 IP 或域名，不要包含协议和端口',
  );
export const serverSchema = z.object({
  name: z.string().trim().min(1, '请填写服务器名称').max(100),
  host,
  port: z.coerce.number().int().min(1).max(65535),
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.@-]{1,64}$/, 'SSH 用户名格式不正确'),
  auth_type: z.enum(['password', 'key']),
  environment: z.enum(['production', 'staging', 'development']),
  group_name: z.string().trim().max(64).default(''),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
  notes: z.string().max(4000).default(''),
  favorite: z.boolean().default(false),
  password: z.string().max(4096).optional(),
  privateKey: z.string().max(65536).optional(),
  passphrase: z.string().max(4096).optional(),
  clearPassphrase: z.boolean().optional(),
});
export const passwordSchema = z.object({
  password: z.string().min(10, '管理密码至少需要 10 个字符').max(128),
});
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/, '账号需为 3–64 位字母、数字、点、下划线或短横线');
export const userSchema = z.object({
  username: usernameSchema,
  display_name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'member']),
  permissions: z.object({
    'server.create': z.boolean(),
    'server.edit': z.boolean(),
    'server.delete': z.boolean(),
    'server.connect': z.boolean(),
    'cloud.manage': z.boolean().default(false),
  }),
  active: z.boolean().default(true),
  password: z.string().min(10, '密码至少 10 个字符').max(128).optional(),
});
