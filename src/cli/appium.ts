import { spawn } from 'node:child_process';
import { appiumEntry, appiumHome } from '../native/appium/server.ts';

const drivers: Record<string, string> = { android: 'uiautomator2', ios: 'xcuitest', macos: 'mac2' };
const [command = 'list', platform] = process.argv.slice(2);
try {
  if (!['list', 'install', 'doctor'].includes(command) || (command !== 'list' && !drivers[platform])) throw new Error('Usage: maat appium list | install/doctor android|ios|macos');
  const args = command === 'list' ? ['driver', 'list', '--installed'] : ['driver', command, drivers[platform]];
  process.exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [appiumEntry(), ...args], { stdio: 'inherit', env: { ...process.env, APPIUM_HOME: appiumHome() } });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) { console.error(String(error)); process.exitCode = 1; }
