const { createWriteStream, writeFile, access, rename, F_OK } = require('fs')
const { join, resolve, basename, dirname } = require('path')
const cluster = require('cluster')
const dns = require('dns').promises
const { spawn } = require('child_process')
const ffmpegBin = require('ffmpeg-static')
const mkdirp = require('mkdirp')
const merge = require('lodash.merge')
const TwitchStream = require('get-twitch-stream')
const TwitchPubSub = require('twitch-realtime')
const chalk = require('chalk')
const stripAnsi = require('strip-ansi')
const minimist = require('minimist')(process.argv.slice(2))

process.stdout.write('\u001b[2J\u001b[0;0H') // clear console

const config_defaults = {
  streamer: 'TwitchUser',
  recorder: {
    stream_format: [
      'source'
    ],
    output_template: join('.', 'recordings', ':shortYear.:month.:day :period -- :streamer -- :title')
  },
  time: {
    timezone: 'Europe/London',
    timezone_format: 'en-GB'
  },
  developer: {
    log: 'debug.log',
    debug: false,
    verbose: false,
    simulate: false,
    dump_config: false
  }
}
let config_user = {}
try {
  config_user = minimist.config ? require(resolve(minimist.config)) : require('./config')
} catch (error) {}
const config_args = {
  streamer: minimist.streamer,
  recorder: {
    stream_format: minimist.format ? minimist.format.split('/') : undefined,
    output_template: minimist.output_template
  },
  time: {
    timezone: minimist.tz,
    timezone_format: minimist.tz_format
  },
  developer: {
    log: minimist.log,
    debug: minimist.debug || minimist.verbose,
    verbose: minimist.verbose,
    simulate: minimist.simulate,
    dump_config: minimist.dump_config
  }
}
const config = merge(config_defaults, config_user, config_args)

if (minimist.help) {
  showHelp()
}
if (config.developer.debug) {
  if (!config.developer.dump_config) {
    config.developer.log = createWriteStream(resolve(config.developer.log), {
      flags: 'w'
    })
  }
  if (config.developer.verbose) {
    log(`${chalk.magentaBright('Verbose Debug Mode Enabled')}`)
  } else {
    log(`${chalk.magentaBright('Debug Mode Enabled')}`)
  }
}
if (config.developer.simulate) {
  log(`${chalk.magentaBright('Downloading Disabled')}`)
}
if (config.developer.dump_config) {
  log(`${chalk.magentaBright(`Dumping config to 'config_dump.json'`)}`)
  writeFile('config_dump.json', JSON.stringify(config, null, 2), {
    flags: 'w'
  }, err => {
    if (err) {
      return process.exit(0)
    }
    process.exit(0)
  })
}

function debug (msg) {
  let write = msg => {
    if (config.developer.debug && !config.developer.dump_config) {
      config.developer.log.write(msg)
    }
  }
  if (msg !== null) {
    if (config.developer.debug) {
      write(`[${new Date().toLocaleString(config.time.timezone_format)}] `)
      if (msg instanceof Buffer) {
        write(`${msg}`)
      } else if (msg instanceof Object) {
        write(`${JSON.stringify(msg, null, 2)}\n`)
      } else {
        write(`${stripAnsi(msg)}\n`)
      }
    }
  }
}
function log (msg) {
  if (msg !== null) {
    if (config.developer.debug) debug(msg)
    console.log(`${chalk.grey(`[${new Date().toLocaleString(config.time.timezone_format)}]`)}`, msg)
  }
}

if (cluster.isWorker) {
  const app = {
    stream: {
      live: false,
      recording: false,
      start: null
    },
    exiting: false
  }
  const twitchStream = new TwitchStream({
    channel: `${config.streamer}`
  })

  twitchStream.streamLive()
  .then(isLive => {
    if (isLive) {
      log(`${config.streamer} is ${chalk.greenBright('live')}`)

      app.stream.live = true
      app.stream.start = new Date().toISOString()

      recordStream()
    } else {
      log(`${config.streamer} is ${chalk.redBright('offline')}`)
    }
  })
  .catch(err => debug)

  const twitchPubSub = new TwitchPubSub({
    defaultTopics: [
      `video-playback.${config.streamer.toLowerCase()}`
    ],
    reconnect: true
  })

  twitchPubSub.on('connect', () => {
    debug(`Connected to Twitch PubSub`)
  })
  twitchPubSub.on('close', () => {
    debug(`Disconnected from Twitch PubSub`)
  })
  twitchPubSub.on('raw', data => {
    if (config.developer.verbose) debug(data)
  })
  twitchPubSub.on('stream-up', data => {
    if (!config.developer.verbose) debug(data)
    if (!app.stream.live) {
      log(`${config.streamer} is now ${chalk.greenBright('live')}`)

      app.stream.live = true
      app.stream.start = new Date().toISOString()

      recordStream()
    }
  })
  twitchPubSub.on('stream-down', data => {
    if (!config.developer.verbose) debug(data)
    if (app.stream.live) {
      log(`${config.streamer} is ${chalk.redBright('offline')}`)

      app.stream.live = false
      app.stream.start = null
    }
  })

  async function recordStream () {
    let filename = `${config.recorder.output_template}.mp4`

    let date_raw = new Date(`${app.stream.start}`)
    let timeZoneDate = date_raw.toLocaleString('en-GB', {
      timeZone: `${config.time.timezone}`,
    }).split(', ')
    let timeZoneTime = date_raw.toLocaleString(`${config.time.timezone_format}`, {
      timeZone: `${config.time.timezone}`,
    }).split(', ')
    let titleRaw = await twitchStream.getStreamTitle(config.streamer)

    let name = config.streamer.replace(/[/\\?%*:|"<>]/g, '_')
    let title = titleRaw.replace(/[/\\?%*:|"<>]/g, '#')
    let date = timeZoneDate[0].replace(/\//g, '.')
    let time = timeZoneTime[1].split(' ')[0].replace(/\:/g, '-')
    let day = timeZoneDate[0].split('/')[0]
    let month = timeZoneDate[0].split('/')[1]
    let year = timeZoneDate[0].split('/')[2]
    let shortYear = year.toString().substring(2)
    let period = timeZoneDate[1].split(':')[0] < 12 ? 'AM' : 'PM'

    filename = filename.replace(/:streamer/gi, `${name}`)
    filename = filename.replace(/:title/gi, `${title}`)
    filename = filename.replace(/:date/gi, `${date}`)
    filename = filename.replace(/:time/gi, `${time}`)
    filename = filename.replace(/:day/gi, `${day}`)
    filename = filename.replace(/:month/gi, `${month}`)
    filename = filename.replace(/:year/gi, `${year}`)
    filename = filename.replace(/:shortYear/gi, `${shortYear}`)
    filename = filename.replace(/:period/gi, `${period}`)
    filename = filename.replace(/[?%*:|"<>]/g, '-')

    if (process.platform === 'win32') {
      filename = filename.replace(/\//g, '\\') // convert unix path seperators to windows style
      filename = filename.replace(/[?%*:|"<>]/g, '-')
      filename = filename.replace(/^([A-Z-a-z])(-)\\/, '$1:\\') // windows drive letter fix
    } else {
      filename = filename.replace(/\\/g, '/') // convert windows path seperators to unix style
      filename = filename.replace(/[!?%*:;|"'<>`\0]/g, '-') // unix invaild filename chars
    }

    mkdirp(dirname(resolve(filename)))

    filename = await reserveFile({ basefile: filename })

    new Promise(async (p_resolve, p_reject) => {
      let streamUrl = await twitchStream.getStreamURL(config.recorder.format)

      debug(`stream url: ${streamUrl}`)
      debug(`downloading stream to: ${resolve(filename)}`)

      let ffmpeg_args = [
        '-hide_banner',
        '-loglevel', 'quiet',
        '-n',
        '-re', // fix reading stream too fast, also fix reading too slow (timeout issues)
        '-i', `${streamUrl}`,
        '-c', 'copy',
        '-f', 'mp4',
        `${resolve(filename)}`,
      ]
      let ffmpeg_args_simulated = [
        '-hide_banner',
        '-loglevel', 'quiet',
        '-n',
        '-i', `${streamUrl}`,
        '-c', 'copy',
        '-f', 'null',
        '-',
      ]
      let ffmpeg = spawn(ffmpegBin, (config.developer.simulate ? ffmpeg_args_simulated : ffmpeg_args), {
        cwd: process.cwd()
      })

      function abort (signal) {
        app.exiting = true
        try {
          ffmpeg.stdin.setEncoding('utf-8')
          ffmpeg.stdin.write('q\n')
        } catch (error) {}
        if (signal === 'SIGINT' || signal === 'SIGHUP') {
          setTimeout(() => {
            process.exit(0)
          }, 2000)
        } else {
          setTimeout(() => {
            process.exit(1) // attempt restart
          }, 2000)
        }
      }

      process.on('SIGINT', abort)
      process.on('SIGHUP', abort)
      process.on('uncaughtException', abort)

      ffmpeg.on('close', code => {
        process.removeListener('SIGINT', abort)
        process.removeListener('SIGHUP', abort)
        process.removeListener('uncaughtException', abort)

        return p_resolve(code)
      })

      ffmpeg.on('error', error => {
        return p_reject(error)
      })

      if (ffmpeg.pid) {
        log(`${chalk.cyanBright(`• `)}${chalk.reset(`Recording '${config.streamer}' live stream to file`)}`)

        app.stream.recording = true
      }
    })
    .then(code => {
      app.stream.recording = false

      if (config.developer.verbose)  debug(`ffmpeg exited with code ${code}`)
      if (code === 0) {
        if (!app.exiting) {
          log(`${chalk.greenBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream completed`)}`)
        } else if (app.stream.live && app.exiting) {
          log(`${chalk.yellowBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream aborted; a partial stream may have been saved`)}`)
        }
      } else {
        if (app.stream.live && !app.exiting) {
          log(`${chalk.redBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream error; a partial stream may have been saved`)}`)
        } else if (app.stream.live && app.exiting) {
          log(`${chalk.yellowBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream aborted; a partial stream may have been saved`)}`)
        }
      }
    })
    .catch(err => {
      log(`${chalk.redBright(`• `)}${chalk.reset(`Unable to start recording '${config.streamer}' live stream`)}`)
      debug(`failed to start subprocess: ${err.message}`)

      process.exit(0) // abort because something has gone wrong with spawn
    })
  }

  function reserveFile (options) {
    let basefile = options.basefile
    let checkfile = options.checkfile !== undefined? options.checkfile : options.basefile
    let parts = options.parts !== undefined ? options.parts : 0

    return new Promise((p_resolve, p_reject) => {
      if (parts === 0) {
        access(resolve(`${join(dirname(basefile), basename(basefile, `.mp4`))} (part 1).mp4`), F_OK, err => {
          if (!err) { // file exist
            parts++
            return p_resolve({
              basefile: basefile,
              checkfile: `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`,
              parts: parts
            })
          } else { // file not exist
            access(resolve(checkfile), F_OK, err => {
              if (!err) { // file exist, rename
                parts++
                let newfile = `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`
                rename(resolve(basefile), resolve(newfile), err => {
                  if (!err) debug(`renamed ${basefile} -> ${newfile}`)
                })
                parts++
                return p_resolve({
                  basefile: basefile,
                  checkfile: `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`,
                  parts: parts
                })
              } else { // file not exist, this must be first part
                return p_resolve(checkfile)
              }
            })
          }
        })
      } else {
        access(resolve(checkfile), F_OK, err => {
          if (!err) { // file exist
            parts++
            return p_resolve({
              basefile: basefile,
              checkfile: `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`,
              parts: parts
            })
          } else { // file not exist
            return p_resolve(checkfile)
          }
        })
      }
    })
    .then(data => {
      if (data instanceof Object) {
        return reserveFile(data)
      } else {
        return data
      }
    })
  }
} else if (cluster.isMaster) {
  let restart = null

  process.on('SIGINT', exit)
  process.on('SIGHUP', exit)
  function exit () { // allow manual quit
    setTimeout(() => {
      clearTimeout(restart)
    }, 500)
  }

  cluster.fork()
  cluster.on('exit', (worker, code, signal) => {
    if (code !== 0) { // if crash try restart
      process.stdout.write('\u001b[2J\u001b[0;0H')
      log(`${chalk.redBright(`Application unexpectedly exit with code: ${chalk.grey(code)}`)}`)
      log(`${chalk.magentaBright('Restarting...')}`)
      let attempts = 0
      function delayedRestart () {
        return setTimeout(() => {
          dns.lookup('twitch.tv')
          .then(() => { // can now fork
            process.stdout.write('\u001b[2J\u001b[0;0H')
            cluster.fork()
          })
          .catch(() => { // try again
            attempts++
            log(`${chalk.magentaBright(`No internet connection detected trying again... (attempts ${attempts})`)}`)
            restart = delayedRestart()
          })
        }, 1000)
      }
      restart = delayedRestart()
    }
  })
}

function showHelp () {
  console.log(`
    ${chalk.magentaBright(`Twitch Stream Recorder`)}  -  Monitor Twitch Streamer and Record Live Stream to disk automatically.
    ------------------------------------------------------------------------------------------------
    ${chalk.grey(`Created by Bradley 'Bred/cmd430' Treweek`)}


      Usage: node index ${chalk.grey(`[options] [dev options]`)}

        Options:
          --streamer=${chalk.grey(`<streamer username>`)}    Set the Twitch streamer to monitor
                                            Default: ${chalk.grey(`sweet_anita`)}

          --output_template=${chalk.grey(`"<template>"`)}    Set template and path for recorded streams, if path does not exit it will be created
                                            Accepts tokens; :streamer, :title, :date, :time, :day, :month, :year, :shortYear, :period
                                            Default: ${chalk.grey(`./recordings/:date, :time -- :streamer`)}

          --format=${chalk.grey(`<format>`)}                 Set the stream record quality
                                            Accepts list of qualities in order of preference seperated by / e.g ${chalk.grey(`1080p60/1080p/720p60/720p`)}
                                            Default: ${chalk.grey(`source`)}

          --tz=${chalk.grey(`<timezone>`)}                   Set the timezone used when dating saved streams
                                            Default: ${chalk.grey(`Europe/London`)}

          --tz_format=${chalk.grey(`<timezone format>`)}     Set the timezone for local logs and file names, accepts en-GB or en-US
                                            Default: ${chalk.grey(`en-GB`)}

          --config=${chalk.grey(`<path>`)}                   Set path to config.json to use
                                            Default: ${chalk.grey(`./config.json`)}

          --help                            Show this help

        Dev Options:
          --debug                           Log data to debug.log file
          --verbose                         adds logging for all Twitch api events, this can lead to a very large log file, --debug is implied
          --simulate                        Disable writing to disk (do not keep downloaded stream)
          --dump_config                     Dump config as seen by the application to 'config.dump' then exit
  `)
  process.exit(0)
}
