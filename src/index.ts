import mysql from 'mysql2'
import { Pool, PoolConnection, PoolOptions, RowDataPacket, OkPacket, Query } from './mysql2'
import { Readable } from 'stream'

export interface DbConfig extends PoolOptions {
  skiptzfix?: boolean
}

export interface QueryOptions {
  saveAsPrepared?: boolean
  nestTables?: true|'_'
  rowsAsArray?: boolean
}

export interface StreamOptions extends QueryOptions {
  highWaterMark?: number
}

interface canBeStringed {
  toString: () => string
}
interface BindObject { [keys: string]: BindParam }
type BindParam = boolean|number|string|null|Date|Buffer|canBeStringed|BindObject
type ColTypes = BindParam
type BindInput = BindParam[]|BindObject

interface GenericReadable<T> extends Readable {
  [Symbol.asyncIterator]: () => AsyncIterableIterator<T>
}

// implemented my own conversion to Readable stream because mysql2's is broken:
// it calls stream.emit('close') while the consumer is still reading from the buffer
// higher highWaterMark settings make it worse
function stream<ReturnType> (query: Query, options: StreamOptions) {
  const anyquery = query as any
  let canceled = false
  const stream = new Readable({ ...options, objectMode: true }) as GenericReadable<ReturnType>
  stream._read = () => {
    anyquery._connection?.resume()
  }
  stream._destroy = (err: Error, cb) => {
    if (err) stream.emit('error', err)
    canceled = true
    anyquery._connection.resume()
    cb()
  }
  query.on('result', row => {
    if (canceled) return
    if (!stream.push(row)) {
      anyquery._connection.pause()
    }
  })
  query.on('error', err => {
    if (canceled) return
    stream.emit('error', err)
  })
  query.on('end', () => {
    if (canceled) return
    stream.push(null)
  })
  return stream
}

export class Queryable {
  protected conn: PoolConnection | Pool

  constructor (conn: PoolConnection | Pool) {
    this.conn = conn
  }

  async query (sql: string, binds?: BindInput, options?: QueryOptions): Promise<RowDataPacket[] | RowDataPacket[][] | OkPacket | OkPacket[]> {
    if (!options) options = {}
    if (typeof binds === 'object' && !Array.isArray(binds)) (options as any).namedPlaceholders = true
    return new Promise((resolve, reject) => {
      if (options?.saveAsPrepared) {
        this.conn.execute({ ...options, sql, values: binds }, (err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      } else {
        this.conn.query({ ...options, sql, values: binds }, (err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      }
    })
  }

  async getval<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const row = await this.getrow<[ReturnType]>(sql, binds, options)
    if (row) return Object.values(row)[0]
  }

  async getvals<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const rows = await this.getall<[ReturnType]>(sql, binds, options)
    return rows.map(r => Object.values(r)[0])
  }

  async getrow<ReturnType = RowDataPacket> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.getall<ReturnType>(sql, binds, options)
    if (results?.length > 0) return results?.[0]
  }

  async getall<ReturnType = RowDataPacket> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.query(sql, binds, options)
    return results as ReturnType[]
  }

  async execute (sql: string, binds?: BindInput, options?: QueryOptions) {
    await this.query(sql, binds, options)
    return true
  }

  async update (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query(sql, binds, options)
    return (result as OkPacket).changedRows
  }

  async insert (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query(sql, binds, options)
    return (result as OkPacket).insertId
  }

  stream<ReturnType = RowDataPacket> (sql: string, options: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = RowDataPacket> (sql: string, binds?: BindInput, options?: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = RowDataPacket> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    let binds
    if (!options && (bindsOrOptions?.highWaterMark || bindsOrOptions?.objectMode)) {
      options = bindsOrOptions
      binds = []
    } else {
      binds = bindsOrOptions
    }
    const result = options?.saveAsPrepared ? this.conn.execute({ ...options, sql, values: binds }) : this.conn.query({ ...options, sql, values: binds })
    return stream<ReturnType>(result, options ?? {})
  }

  iterator<ReturnType = RowDataPacket> (sql: string, options: StreamOptions): AsyncIterableIterator<ReturnType>
  iterator<ReturnType = RowDataPacket> (sql: string, binds?: BindInput, options?: StreamOptions): AsyncIterableIterator<ReturnType>
  iterator<ReturnType = RowDataPacket> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const ret = this.stream<ReturnType>(sql, bindsOrOptions, options)[Symbol.asyncIterator]()
    return ret
  }
}

export default class Db extends Queryable {
  protected pool: Pool

  constructor (config?: DbConfig) {
    const skiptzfix = (config?.skiptzfix ?? false) || Boolean(process.env.MYSQL_SKIPTZFIX)
    delete config?.skiptzfix
    const poolSizeString = process.env.MYSQL_POOL_SIZE ?? process.env.DB_POOL_SIZE
    const pool = mysql.createPool({
      ...config,
      host: config?.host ?? process.env.MYSQL_HOST ?? process.env.DB_HOST ?? 'mysql',
      user: config?.user ?? process.env.MYSQL_USER ?? process.env.DB_USER ?? 'root',
      password: config?.password ?? process.env.MYSQL_PASS ?? process.env.DB_PASS ?? 'secret',
      database: config?.database ?? process.env.MYSQL_DATABASE ?? process.env.DB_DATABASE ?? 'default_database',
      // client side connectTimeout is unstable in mysql2 library
      // it throws an error you can't catch and crashes node
      // best to leave this at 0 (disabled)
      connectTimeout: 0,
      // to harden connections against failure https://github.com/sidorares/node-mysql2/issues/683
      keepAliveInitialDelay: 10000,
      enableKeepAlive: true,
      ...(!skiptzfix ? { timezone: 'Z' } : {}),
      ...(poolSizeString ? { connectionLimit: parseInt(poolSizeString) } : {})
    })
    if (!skiptzfix) {
      pool.on('connection', function (connection: PoolConnection) {
        connection.query('SET time_zone="UTC"')
      })
    }
    super(pool)
    this.pool = pool
  }

  async wait () {
    while (true) {
      try {
        await this.getrow('select 1')
        break
      } catch (err) {
        if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
          await new Promise(resolve => setTimeout(resolve, 500))
        } else {
          throw err
        }
      }
    }
  }

  async transaction <ReturnType> (callback: (db: Queryable) => Promise<ReturnType>, options?: { retries?: number }): Promise<ReturnType> {
    const conn = await new Promise<PoolConnection>((resolve, reject) => {
      this.pool.getConnection((err: any, conn: PoolConnection) => {
        if (err) reject(err)
        else resolve(conn)
      })
    })
    const db = new Queryable(conn)
    try {
      await db.execute('START TRANSACTION')
      try {
        const ret = await callback(db)
        await db.execute('COMMIT')
        return ret
      } catch (e) {
        const isDeadlock = e.errno === 1213
        if (isDeadlock && options?.retries) {
          return await this.transaction(callback, { ...options, retries: options.retries - 1 })
        } else {
          if (!isDeadlock) await db.execute('ROLLBACK')
          throw e
        }
      }
    } finally {
      conn.release()
    }
  }
}
