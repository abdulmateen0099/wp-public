import path from 'node:path';

// Keep all accounts in the same persistent directory across deployments.
export function resolveAuthDirectory(appDirectory, env = process.env) {
    return path.resolve(appDirectory,
        env.AUTH_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || 'auth');
}
