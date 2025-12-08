// api/process-day.js - V0.6.1 修正版 (特殊胜利优先)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    const { roomCode } = req.body;

    // 1. 获取数据
    const { data: players } = await supabase.from('players').select('*').eq('room_code', roomCode);
    const { data: votes } = await supabase.from('votes').select('*').eq('room_code', roomCode);
    const { data: room } = await supabase.from('rooms').select('round_state').eq('code', roomCode).single();

    if (!players || !votes || !room) return res.status(500).json({ message: '数据读取失败' });

    let logs = [];
    let playerUpdates = [];
    const currentRoundNum = parseInt(room.round_state.split(' ')[1]) || 1;

    // --- A. 计票逻辑 ---
    let voteCounts = {}; 
    players.forEach(p => voteCounts[p.id] = 0);

    votes.forEach(v => {
        if (!v.target_id) return; 
        let weight = 1;
        // 双票使者逻辑
        const voter = players.find(p => p.id === v.voter_id);
        if (voter && voter.role === '双票使者' && voter.is_alive) weight = 2;
        voteCounts[v.target_id] += weight;
    });

    // --- B. 应用防御 (守护者) ---
    players.forEach(p => {
        if (p.flags && p.flags.is_protected && voteCounts[p.id] > 0) {
            voteCounts[p.id] = 0; // 票数归零
        }
    });

    // --- C. 处决判定 ---
    let maxVotes = 0;
    Object.values(voteCounts).forEach(count => { if (count > maxVotes) maxVotes = count; });

    const candidates = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes);
    let eliminatedPlayerId = null; // 记录死者ID

    if (maxVotes === 0) {
        logs.push({ message: '今日无人投票，平安无事。', tag: 'PUBLIC' });
    } else if (candidates.length > 1) {
        // 平票 -> 无人死亡
        const names = candidates.map(id => players.find(p => p.id == id)?.name).join(', ');
        logs.push({ message: `投票结果：${names} 并列获得 ${maxVotes} 票。根据规则，平票无人出局。`, tag: 'PUBLIC' });
    } else {
        // 单人最高 -> 处决
        eliminatedPlayerId = parseInt(candidates[0]);
        const victim = players.find(p => p.id === eliminatedPlayerId);
        if (victim) {
            playerUpdates.push({ ...victim, is_alive: false, flags: {} });
            logs.push({ message: `投票结果：玩家【${victim.name}】以 ${maxVotes} 票被处决。`, tag: 'PUBLIC' });
        }
    }

    // --- D. 胜负判定 (逻辑修正) ---
    
    // 1. 计算当前的存活列表 (排除掉刚刚被处决的人)
    const alivePlayers = players.filter(p => p.is_alive && p.id !== eliminatedPlayerId);
    const aliveCount = alivePlayers.length;
    
    let nextState = '';
    
    // 🔍 判定 1: 三人王者特殊胜利 (优先级最高)
    const threeKings = alivePlayers.find(p => p.role === '三人王者');
    
    if (aliveCount === 3 && threeKings) {
        // 触发特殊胜利
        nextState = 'GAME OVER';
        logs.push({ 
            message: `🎉 局势突变！存活人数为 3 人，玩家【${threeKings.name}】触发【三人王者】技能，直接获得胜利！`, 
            tag: 'PUBLIC' 
        });
    } 
    // 🔍 判定 2: 常规游戏结束 (人数 <= 2)
    else if (aliveCount <= 2) {
        nextState = 'GAME OVER';
        logs.push({ 
            message: '🚫 存活人数已不足 2 人，游戏结束！剩余幸存者共同获胜。', 
            tag: 'PUBLIC' 
        });
    } 
    // 🔄 判定 3: 游戏继续
    else {
        nextState = `NIGHT ${currentRoundNum + 1}`;
    }

    // --- 提交更改 ---
    if (playerUpdates.length > 0) await supabase.from('players').upsert(playerUpdates);
    await supabase.from('votes').delete().eq('room_code', roomCode); 

    if (logs.length > 0) {
        const logsPayload = logs.map(l => ({
            room_code: roomCode,
            message: l.message,
            viewer_ids: null,
            tag: l.tag,
            created_at: new Date().toISOString()
        }));
        await supabase.from('game_logs').insert(logsPayload);
    }

    await supabase.from('rooms').update({ round_state: nextState }).eq('code', roomCode);

    res.status(200).json({ success: true, message: '结算完成' });
}