import { scaleSleep } from '@/services/vision-speed';
import TradeEngine from '../trade';
import getBotInterface from './BotInterface';
import getTicksInterface from './TicksInterface';
import getSignalLabInterface from './SignalLabInterface';
import getToolsInterface from './ToolsInterface';
import getVisionInterface from './VisionInterface';

// Pauses are scaled by the workspace's Fast/Slow setting, so one control
// changes how quickly every strategy that waits actually trades.
const sleep = (observer, arg = 1) => {
    return new Promise(
        r =>
            // eslint-disable-next-line no-promise-executor-return
            setTimeout(
                () => {
                    r();
                    setTimeout(() => observer.emit('CONTINUE'), 0);
                },
                scaleSleep(arg) * 1000
            ),
        () => {}
    );
};

const Interface = $scope => {
    const tradeEngine = new TradeEngine($scope);
    const { observer } = $scope;
    const getInterface = () => {
        return {
            ...getBotInterface(tradeEngine),
            ...getToolsInterface(tradeEngine),
            getTicksInterface: getTicksInterface(tradeEngine),
            getSignalLabInterface: getSignalLabInterface(),
            getVisionInterface: getVisionInterface(tradeEngine),
            watch: (...args) => tradeEngine.watch(...args),
            sleep: (...args) => sleep(observer, ...args),
            alert: (...args) => alert(...args), // eslint-disable-line no-alert
            prompt: (...args) => prompt(...args), // eslint-disable-line no-alert
            console: {
                log(...args) {
                    // eslint-disable-next-line no-console
                    console.log(new Date().toLocaleTimeString(), ...args);
                },
            },
        };
    };
    return { tradeEngine, observer, getInterface };
};

export default Interface;
