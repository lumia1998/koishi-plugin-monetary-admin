import { Context, Schema } from 'koishi'
import { } from 'koishi-plugin-monetary'

export const name = 'monetary-admin'
export const inject = ['monetary', 'database']

export interface Config { }

export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
  async function resolveUser(target: string) {
    if (!target) throw '请输入目标用户。'
    const [platform, pid] = target.split(':')
    if (!platform || !pid) throw '目标用户格式错误。'

    const bindings = await ctx.database.get('binding', { platform, pid }, ['aid'])
    if (bindings.length === 0) throw '未找到该用户。'

    const uid = bindings[0].aid
    const [user] = await ctx.database.get('user', { id: uid }, ['name'])
    let name = user?.name || target

    if (!user?.name) {
      const bot = ctx.bots.find(b => b.platform === platform)
      if (bot) {
        try {
          const platformUser = await bot.getUser(pid)
          if (platformUser?.name) {
            name = platformUser.name
          }
        } catch (e) { }
      }
    }
    return { uid, name }
  }


  ctx.command('monetary.add [target:user] <currency:string> <amount:number>', '给目标用户添加货币', { authority: 5 })
    .userFields(['id'])
    .action(async ({ session }, target, currency, amount) => {
      try {
        let uid: number, name: string

        if (!target) {
          // 如果没有指定目标，则给自己添加
          if (!session?.user?.id) return '无法获取您的用户信息。'
          uid = session.user.id
          name = session.username || String(uid)
        } else {
          const resolved = await resolveUser(target)
          uid = resolved.uid
          name = resolved.name
        }

        if (!currency) return '请输入货币类型。'
        if (!amount) return '请输入金额。'
        if (amount <= 0) return '金额必须为正数。'

        await ctx.monetary.gain(uid, amount, currency)

        return `成功给用户 ${name} (UID: ${uid}) 添加了 ${amount} ${currency}。`
      } catch (e) {
        return typeof e === 'string' ? e : `添加失败: ${e.message}`
      }
    })

  ctx.command('monetary.reduce [target:user] <currency:string> <amount:number>', '扣除目标用户货币', { authority: 5 })
    .alias('扣款')
    .userFields(['id'])
    .action(async ({ session }, target, currency, amount) => {
      try {
        let uid: number, name: string

        if (!target) {
          if (!session?.user?.id) return '无法获取您的用户信息。'
          uid = session.user.id
          name = session.username || String(uid)
        } else {
          const resolved = await resolveUser(target)
          uid = resolved.uid
          name = resolved.name
        }

        if (!currency) return '请输入货币类型。'
        if (!amount) return '请输入金额。'
        if (amount <= 0) return '金额必须为正数。'

        await ctx.monetary.gain(uid, -amount, currency)

        return `成功从用户 ${name} (UID: ${uid}) 扣除了 ${amount} ${currency}。`
      } catch (e) {
        return typeof e === 'string' ? e : `扣除失败: ${e.message}`
      }
    })

  ctx.command('monetary.clear [target:user] <currency:string>', '清零目标用户指定货币', { authority: 5 })
    .alias('清零')
    .userFields(['id'])
    .action(async ({ session }, target, currency) => {
      try {
        let uid: number, name: string

        if (!target) {
          if (!session?.user?.id) return '无法获取您的用户信息。'
          uid = session.user.id
          name = session.username || String(uid)
        } else {
          const resolved = await resolveUser(target)
          uid = resolved.uid
          name = resolved.name
        }

        if (!currency) return '请输入货币类型。'

        await ctx.database.set('monetary', { uid, currency }, { value: 0 })
        return `成功将用户 ${name} (UID: ${uid}) 的 ${currency} 余额清零。`
      } catch (e) {
        return typeof e === 'string' ? e : `清零失败: ${e.message}`
      }
    })

  ctx.command('monetary.remove <target:user>', '删除目标用户的所有货币记录', { authority: 5 })
    .alias('销户')
    .option('force', '-f 强制删除')
    .action(async ({ session, options }, target) => {
      try {
        const { uid, name } = await resolveUser(target)

        if (!options.force) {
          return '该操作将删除用户的所有货币记录，且不可恢复。请使用 --force 选项确认删除。'
        }

        await ctx.database.remove('monetary', { uid })
        return `成功删除用户 ${name} (UID: ${uid}) 的所有货币记录。`
      } catch (e) {
        return typeof e === 'string' ? e : `删除失败: ${e.message}`
      }
    })

  ctx.command('monetary.balance [target:user]', '查询目标用户的货币余额', { authority: 1 })
    .alias('查询余额')
    .userFields(['id'])
    .action(async ({ session }, target) => {
      try {
        let uid: number, name: string

        if (!target) {
          if (!session?.user?.id) return '无法获取您的用户信息。'
          uid = session.user.id
          name = session.username || '您'
        } else {
          const resolved = await resolveUser(target)
          uid = resolved.uid
          name = resolved.name
        }

        const monetaryRecords = await ctx.database.get('monetary', { uid })
        if (monetaryRecords.length === 0) {
          return `用户 ${name} (UID: ${uid}) 暂无任何货币记录。`
        }

        let result = `用户 ${name} (UID: ${uid}) 的货币余额:\n`
        for (const record of monetaryRecords) {
          result += `${record.currency}  ${record.value}\n`
        }
        return result.trim()
      } catch (e) {
        return typeof e === 'string' ? e : `查询失败: ${e.message}`
      }
    })

  ctx.command('monetary.transfer <target:user> <currency:string> <amount:number>', '转账给目标用户', { authority: 1 })
    .alias('转账')
    .userFields(['id'])
    .action(async ({ session }, target, currency, amount) => {
      try {
        if (!session?.user?.id) return '无法获取您的用户信息。'
        if (!currency) return '请输入货币类型。'
        if (!amount) return '请输入金额。'
        if (amount <= 0) return '转账金额必须为正数。'

        const senderUid = session.user.id
        const { uid: targetUid, name: targetName } = await resolveUser(target)

        if (senderUid === targetUid) return '不能给自己转账。'

        // 检查发送者余额
        const senderRecords = await ctx.database.get('monetary', { uid: senderUid, currency })
        if (senderRecords.length === 0 || senderRecords[0].value < amount) {
          return `您的 ${currency} 余额不足。`
        }

        // 执行转账
        await ctx.monetary.gain(senderUid, -amount, currency)
        await ctx.monetary.gain(targetUid, amount, currency)

        const [senderUser] = await ctx.database.get('user', { id: senderUid }, ['name'])
        const senderName = senderUser?.name || String(senderUid)

        return `成功将 ${amount} ${currency} 从 ${senderName} 转账给 ${targetName}。`
      } catch (e) {
        return typeof e === 'string' ? e : `转账失败: ${e.message}`
      }
    })
}
