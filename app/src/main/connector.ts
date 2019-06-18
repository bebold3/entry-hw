'use strict';
import Readline from '@serialport/parser-readline'; // modify
import Delimiter from '@serialport/parser-delimiter';
import SerialPort from '@serialport/stream';
import Bindings from '@entrylabs/bindings';
import SerialPortType = require('serialport');

SerialPort.Binding = Bindings;

interface SerialPortOptions extends SerialPortType.OpenOptions {
    flowControl?: string;
}

interface SerialPortWithParser extends SerialPortType {
    parser?:
        SerialPortType.parsers.ByteLength |
        SerialPortType.parsers.CCTalk |
        SerialPortType.parsers.Delimiter |
        SerialPortType.parsers.Readline |
        SerialPortType.parsers.Ready |
        SerialPortType.parsers.Regex;
}

/**
 * 스캔이 끝난 후, 선택된 포트로 시리얼포트를 오픈하는 클래스
 * 스캐너에서 open, initialize 가 일어나고,
 * 라우터에서 setRouter, connect 를 거쳐 통신한다.
 */
class Connector {
    options: HardwareConfig;
    hwModule: HardwareModule;
    router?: Router;
    serialPort?: SerialPortWithParser;
    connected: boolean;
    received: boolean;
    lostTimer: number;
    isSending: boolean;
    executeFlash: boolean;
    flashFirmware?: NodeJS.Timeout;
    slaveTimer?: NodeJS.Timeout;
    connectionLostTimer?: NodeJS.Timeout;
    requestLocalDataInterval?: NodeJS.Timeout;
    advertiseInterval?: NodeJS.Timeout;

    static get DEFAULT_CONNECT_LOST_MILLS() {
        return 1000;
    }

    static get DEFAULT_SLAVE_DURATION() {
        return 1000;
    }

    constructor(hwModule: HardwareModule, hardwareOptions: HardwareConfig) {
        this.options = hardwareOptions;
        this.hwModule = hwModule;

        this.router = undefined;
        this.serialPort = undefined;
        this.connected = false;
        this.received = false;
        this.lostTimer = Connector.DEFAULT_CONNECT_LOST_MILLS;
        this.isSending = false;
        this.executeFlash = false;
    }

    /**
     * MainRouter 를 세팅한다.
     */
    setRouter(router: Router) {
        this.router = router;
    }

    /**
     * 시리얼포트 생성자 옵션을 만든다.
     * @private
     */
    _makeSerialPortOptions(serialPortOptions: SerialPortOptions): SerialPortOptions {
        const _options: SerialPortOptions = {
            autoOpen: true,
            baudRate: 9600,
            parity: 'none',
            dataBits: 8,
            stopBits: 1,
        };

        if (serialPortOptions.flowControl === 'hardware') {
            _options.rtscts = true;
        } else if (serialPortOptions.flowControl === 'software') {
            _options.xon = true;
            _options.xoff = true;
        }

        Object.assign(_options, serialPortOptions);
        return _options;
    }

    /**
     * 시리얼포트를 오픈한다.
     */
    open(port: string) {
        return new Promise((resolve, reject) => {
            const hardwareOptions = this.options;
            this.lostTimer = hardwareOptions.lostTimer || Connector.DEFAULT_CONNECT_LOST_MILLS;

            const serialPort = new SerialPort(port, this._makeSerialPortOptions(hardwareOptions));
            this.serialPort = serialPort;

            const { delimiter, byteDelimiter } = hardwareOptions;
            if (delimiter) {
                serialPort.parser = serialPort.pipe(new Readline({ delimiter }));
            } else if (byteDelimiter) {
                serialPort.parser = serialPort.pipe(new Delimiter({
                    delimiter: byteDelimiter,
                    includeDelimiter: true,
                }));
            }

            serialPort.on('error', reject);
            serialPort.on('open', (error: Error) => {
                serialPort.removeAllListeners('open');
                if (error) {
                    reject(error);
                } else {
                    resolve(this.serialPort);
                }
            });
        });
    };

    /**
     * checkInitialData, requestInitialData 가 둘다 존재하는 경우 handShake 를 진행한다.
     * 둘 중 하나라도 없는 경우는 로직을 종료한다.
     * 만약 firmwareCheck 옵션이 활성화 된 경우면 executeFlash 를 세팅하고 종료한다.
     * 이 플래그는 라우터에서 flasher 를 바로 사용해야하는지 판단한다.
     *
     * @returns {Promise<void>} 준비완료 or 펌웨어체크 준비
     */
    initialize() {
        return new Promise((resolve, reject) => {
            const serialPort = this.serialPort as SerialPortWithParser;
            const {
                control,
                duration = Connector.DEFAULT_SLAVE_DURATION,
                firmwarecheck,
            } = this.options;
            const hwModule = this.hwModule;
            const serialPortReadStream =
                serialPort.parser ? serialPort.parser : serialPort;

            const runAsMaster = () => {
                serialPortReadStream.on('data', (data: any) => {
                    const result = hwModule.checkInitialData(data, this.options);

                    if (result === undefined) {
                        this.send(hwModule.requestInitialData());
                    } else {
                        serialPort.removeAllListeners('data');
                        serialPortReadStream.removeAllListeners('data');
                        this.flashFirmware && clearTimeout(this.flashFirmware);
                        if (result === true) {
                            if (hwModule.setSerialPort) {
                                hwModule.setSerialPort(serialPort);
                            }
                            resolve();
                        } else {
                            reject(new Error('Invalid hardware'));
                        }
                    }
                });
            };

            const runAsSlave = () => {
                // control type is slave
                serialPortReadStream.on('data', (data: any) => {
                    const result = hwModule.checkInitialData(data, this.options);
                    if (result !== undefined) {
                        this.serialPort && this.serialPort.removeAllListeners('data');
                        serialPortReadStream.removeAllListeners('data');
                        this.flashFirmware && clearTimeout(this.flashFirmware);
                        this.slaveTimer && clearTimeout(this.slaveTimer);
                        if (result === true) {
                            if (hwModule.setSerialPort) {
                                hwModule.setSerialPort(this.serialPort);
                            }
                            if (hwModule.resetProperty) {
                                this.send(hwModule.resetProperty());
                            }
                            resolve();
                        } else {
                            reject(new Error('Invalid hardware'));
                        }
                    }
                });
                this.slaveTimer = setInterval(() => {
                    this.send(hwModule.requestInitialData(this.serialPort));
                }, duration);
            };

            if (firmwarecheck) {
                this.flashFirmware = setTimeout(() => {
                    if (this.serialPort) {
                        this.serialPort.parser ?
                            this.serialPort.parser.removeAllListeners('data') :
                            this.serialPort.removeAllListeners('data');
                        this.executeFlash = true;
                    }
                    resolve();
                }, 3000);
            }

            if (hwModule.checkInitialData && hwModule.requestInitialData) {
                if (control === 'master') {
                    runAsMaster();
                } else {
                    runAsSlave();
                }
            } else {
                resolve();
            }
        });
    }

    /**
     * router 와 hwModule 양쪽에 state 변경점을 보낸다.
     * @private
     */
    _sendState(state: string) {
        this.hwModule.eventController && this.hwModule.eventController(state);
        this.router.sendState(state);
    }

    connect() {
        if (!this.router) {
            throw new Error('router must be set');
        }

        if (!this.serialPort) {
            throw new Error('serialPort must be open');
        }

        const router = this.router;
        const serialPort = this.serialPort;
        const hwModule = this.hwModule;
        const {
            control,
            duration = Connector.DEFAULT_SLAVE_DURATION,
            advertise,
            softwareReset,
        } = this.options;

        this.connected = false;
        this.received = true;

        if (hwModule.connect) {
            hwModule.connect();
        }
        this._sendState('connect');

        if (softwareReset) {
            serialPort.set({ dtr: false });
            setTimeout(() => {
                serialPort.set({ dtr: true });
            }, 1000);
        }

        if (hwModule.afterConnect) {
            hwModule.afterConnect(this, (state: string) => {
                this.router.sendState(state);
            });
        }

        const serialPortReadStream =
            serialPort.parser ? serialPort.pipe(serialPort.parser) : serialPort;

        serialPortReadStream.on('data', (data: any) => {
            if (!hwModule.validateLocalData || hwModule.validateLocalData(data)) {
                if (!this.connected) {
                    this.connected = true;
                    this._sendState('connected');
                }

                this.received = true;
                if (hwModule.handleLocalData) {
                    hwModule.handleLocalData(data);
                }

                // 서버로 데이터를 요청한다.
                router.setHandlerData();
                router.sendEncodedDataToServer();

                // 마스터모드인 경우, 데이터를 받자마자 디바이스로 데이터를 보낸다.
                if (control === 'master' && hwModule.requestLocalData) {
                    const data = hwModule.requestLocalData();
                    data && this.send(data);
                }
            }
        });

        serialPort.on('disconnect', () => {
            this.close();
            this._sendState('disconnected');
        });

        // 디바이스 연결 잃어버린 상태에 대한 관리를 모듈에 맡기거나, 직접 관리한다.
        if (hwModule.lostController) {
            hwModule.lostController(this, router.sendState.bind(router));
        } else {
            /*
             * this.lostTimer 타임 안에 데이터를 수신해야한다. 그렇지 않으면 연결해제처리한다.
             */
            this.connectionLostTimer = setInterval(() => {
                if (this.connected) {
                    if (!this.received) {
                        this.connected = false;
                        this._sendState('lost');
                    }
                    this.received = false;
                }
            }, this.lostTimer);
        }

        if (duration && control !== 'master') {
            this.requestLocalDataInterval = setInterval(() => {
                if (hwModule.requestLocalData) {
                    const data = hwModule.requestLocalData();
                    data && this.send(data);
                }
                if (hwModule.getProperty) {
                    const data = hwModule.getProperty();
                    if (data) {
                        this.send(data);
                    }
                }
            }, duration);
        }

        if (advertise) {
            this.advertiseInterval = setInterval(() => {
                router.sendEncodedDataToServer();
            }, advertise);
        }
    }

    clear() {
        this.connected = false;
        if (this.connectionLostTimer) {
            clearInterval(this.connectionLostTimer);
            this.connectionLostTimer = undefined;
        }
        if (this.requestLocalDataInterval) {
            clearInterval(this.requestLocalDataInterval);
            this.requestLocalDataInterval = undefined;
        }
        if (this.advertiseInterval) {
            clearInterval(this.advertiseInterval);
            this.advertiseInterval = undefined;
        }
        if (this.serialPort) {
            this.serialPort.removeAllListeners();
            if (this.serialPort.parser) {
                this.serialPort.parser.removeAllListeners();
            }
        }
        if (this.flashFirmware) {
            clearTimeout(this.flashFirmware);
            this.flashFirmware = undefined;
        }
    };

    close() {
        this.clear();
        if (this.serialPort && this.serialPort.isOpen) {
            this.serialPort.close(() => {
                this.serialPort = undefined;
            });
        }
    };

    /**
     * 시리얼포트로 연결된 디바이스에 데이터를 보낸다.
     */
    send(data: any, callback ?: () => void) {
        if (this.serialPort && this.serialPort.isOpen && data && !this.isSending) {
            this.isSending = true;

            if (this.options.stream === 'string') {
                data = Buffer.from(data, 'utf8');
            }

            this.serialPort.write(data, () => {
                if (this.serialPort) {
                    this.serialPort.drain(() => {
                        this.isSending = false;
                        callback && callback();
                    });
                }
            });
        }
    };
}

export default Connector;
