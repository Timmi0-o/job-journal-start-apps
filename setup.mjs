#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const REPOS = {
	backend: {
		name: 'job-journal-nest-app',
		url: 'https://github.com/Timmi0-o/job-journal-nest-app.git',
		envExample: '.env.example',
		envFile: '.env',
	},
	frontend: {
		name: 'job-journal-next-app',
		url: 'https://github.com/Timmi0-o/job-journal-next-app.git',
		envExample: '.env.example',
		envFile: '.env.local',
	},
};

const BACKEND_PORT = 7878;
const FRONTEND_PORT = 3166;
const BACKEND_WAIT_MS = 180_000;
const BACKEND_POLL_MS = 2_000;

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const gitCmd = isWin ? 'git.exe' : 'git';

const log = (message) => console.log(`\n▶ ${message}`);
const fail = (message) => {
	console.error(`\n✖ ${message}`);
	process.exit(1);
};

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		stdio: 'inherit',
		...options,
	});

	if (result.status !== 0) {
		fail(`Команда завершилась с ошибкой: ${command} ${args.join(' ')}`);
	}
};

const commandExists = (command, args = ['--version']) => {
	const result = spawnSync(command, args, { stdio: 'ignore' });
	return result.status === 0;
};

const ensureCommand = (label, command, args) => {
	if (!commandExists(command, args)) {
		fail(`${label} не найден. Установите ${label} и запустите скрипт снова.`);
	}
};

const ensureRepo = ({ name, url }) => {
	const dir = path.join(ROOT, name);

	if (existsSync(path.join(dir, '.git'))) {
		log(`Обновляю ${name}...`);
		run(gitCmd, ['-C', dir, 'pull', '--ff-only']);
		return dir;
	}

	if (existsSync(dir)) {
		fail(`Папка ${name} уже существует, но это не git-репозиторий. Удалите её или переименуйте.`);
	}

	log(`Клонирую ${name}...`);
	run(gitCmd, ['clone', url, dir]);
	return dir;
};

const ensureEnv = (dir, { envExample, envFile }) => {
	const from = path.join(dir, envExample);
	const to = path.join(dir, envFile);

	if (!existsSync(from)) {
		fail(`Не найден ${path.join(dir, envExample)}`);
	}

	if (existsSync(to)) {
		log(`${envFile} уже есть в ${path.basename(dir)}, пропускаю`);
		return;
	}

	copyFileSync(from, to);
	log(`Создан ${envFile} из ${envExample} в ${path.basename(dir)}`);
};

const waitForPort = (port, timeoutMs) =>
	new Promise((resolve, reject) => {
		const startedAt = Date.now();

		const tryConnect = () => {
			const socket = createConnection({ port, host: '127.0.0.1' });

			socket.on('connect', () => {
				socket.end();
				resolve();
			});

			socket.on('error', () => {
				socket.destroy();

				if (Date.now() - startedAt >= timeoutMs) {
					reject(new Error(`Бэкенд не ответил на порту ${port} за ${timeoutMs / 1000}с`));
					return;
				}

				setTimeout(tryConnect, BACKEND_POLL_MS);
			});
		};

		tryConnect();
	});

const startBackend = (backendDir) => {
	log('Запускаю бэкенд (postgres + migrate + app)...');

	run('docker', ['compose', '-f', 'docker-compose.prod.yml', 'up', '-d', '--build'], {
		cwd: backendDir,
		shell: isWin,
	});

	log(`Жду бэкенд на порту ${BACKEND_PORT}...`);
};

const startFrontend = (frontendDir) => {
	log('Устанавливаю зависимости фронтенда...');
	run(npmCmd, ['install'], { cwd: frontendDir, shell: isWin });

	log(`Запускаю фронтенд на http://localhost:${FRONTEND_PORT}...`);

	const child = spawn(npmCmd, ['exec', 'next', 'dev', '-p', String(FRONTEND_PORT)], {
		cwd: frontendDir,
		stdio: 'inherit',
		shell: isWin,
		env: { ...process.env, PORT: String(FRONTEND_PORT) },
	});

	child.on('exit', (code) => {
		process.exit(code ?? 0);
	});

	return child;
};

const stopBackend = (backendDir) => {
	log('Останавливаю бэкенд...');
	spawnSync('docker', ['compose', '-f', 'docker-compose.prod.yml', 'down'], {
		cwd: backendDir,
		stdio: 'inherit',
		shell: isWin,
	});
};

const main = async () => {
	console.log('Job Journal — bootstrap');
	console.log(`Рабочая папка: ${ROOT}`);

	ensureCommand('Git', gitCmd);
	ensureCommand('Node.js', 'node', ['--version']);
	ensureCommand('npm', npmCmd);
	ensureCommand('Docker', 'docker');
	ensureCommand('Docker Compose', 'docker', ['compose', 'version']);

	const backendDir = ensureRepo(REPOS.backend);
	const frontendDir = ensureRepo(REPOS.frontend);

	ensureEnv(backendDir, REPOS.backend);
	ensureEnv(frontendDir, REPOS.frontend);

	startBackend(backendDir);

	try {
		await waitForPort(BACKEND_PORT, BACKEND_WAIT_MS);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	log(`Бэкенд готов: http://localhost:${BACKEND_PORT}/v1`);

	const frontend = startFrontend(frontendDir);

	const shutdown = () => {
		frontend.kill('SIGTERM');
		stopBackend(backendDir);
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	console.log('\nГотово. Ctrl+C — остановить фронт и бэкенд.\n');
};

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
