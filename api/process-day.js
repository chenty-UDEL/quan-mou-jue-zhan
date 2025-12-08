// api/process-day.js - V0.7 (包含大量新角色的胜利判定)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });
    const { roomCode } = req.body;

    const { data: players } = await supabase.from('players').select('*').eq('room_code', roomCode);
    const { data: votes } = await supabase.from('votes').select('*').eq('room_code', roomCode);
    const { data: room } = await supabase.from('rooms').select('round_state').eq('code', roomCode).single();
    if (!players || !votes || !room) return res.status(500).json({ message: '数据失败' });

    let logs = [];
    let playerUpdates = [];
    const currentRoundNum = parseInt(room.round_state.split(' ')[1]) || 1;
    const totalPlayers = players.length; // 总人数 (用于计算 1/3, 1/2 阈值)
    const aliveCount = players.filter(p=>p.is_alive).length;

    // --- A. 计票逻辑 (含同盟/双票) ---
    let voteCounts = {}; 
    players.forEach(p => voteCounts[p.id] = 0);

    // 1. 基础计票 & 双票使者
    votes.forEach(v => {
        if (!v.target_id) return;
        const voter = players.find(p => p.id === v.voter_id);
        const target = players.find(p => p.id === v.target_id);
        
        // 同盟者判定：互投无效
        if (voter?.role === '同盟者' && voter.flags?.ally_id === v.target_id) return; // 投给了同盟 -> 无效
        
        // 检查：如果目标也是同盟者，且他也投了我 -> 无效
        if (target?.role === '同盟者' && target.flags?.ally_id === v.voter_id) return; 

        let weight = 1;
        if (voter && voter.role === '双票使者' && voter.is_alive) weight = 2;
        
        voteCounts[v.target_id] += weight;
    });

    // 2. 同盟者共投判定 (+1 Bonus)
    // 找到所有同盟者，看他们的 ally 是否也投了同一个人
    const allies = players.filter(p => p.role === '同盟者' && p.is_alive && p.flags?.ally_id);
    allies.forEach(p1 => {
        const p2 = players.find(p => p.id === p1.flags.ally_id);
        if (p2 && p2.is_alive) {
            // 找到两人的投票
            const v1 = votes.find(v => v.voter_id === p1.id);
            const v2 = votes.find(v => v.voter_id === p2.id);
            // 如果投了同一个人(且不是弃票)
            if (v1 && v2 && v1.target_id && v1.target_id === v2.target_id) {
                // 且这票只加一次 (我们约定：只有p1结算时加，p2不算，避免加两次)
                // 简单点：直接给 target + 0.5? 不，容易小数。
                // 逻辑：遍历所有"对"，如果匹配，target+1。为了避免重复，可以用 Set 记录已处理的 pair。
                // 这里简化：同盟者技能描述是 "你与指定玩家...+1票"。
                // 我们在上面基础循环里很难处理"同时"。这里补加上去。
                // 只有当 p1.id < p2.id 时处理，避免重复计算
                if (p1.id < p2.id) {
                     voteCounts[v1.target_id] += 1;
                }
            }
        }
    });

    // 3. 减票守护者 & 利他守护者
    players.forEach(p => {
        // 减票守护者
        if (p.role === '减票守护者' && voteCounts[p.id] > 0) {
            voteCounts[p.id] -= 1;
        }
        // 利他守护 (无敌)
        if (p.flags && p.flags.is_protected && voteCounts[p.id] > 0) {
            voteCounts[p.id] = 0; 
        }
    });

    // --- B. 胜利判定 I (投票即胜) ---
    let winner = null;
    let winReason = '';

    // 10. 集票胜者 (>= 2/3 在场人数)
    const collectorThreshold = Math.ceil(aliveCount * 2 / 3);
    const collector = players.find(p => p.role === '集票胜者' && p.is_alive);
    if (collector && voteCounts[collector.id] >= collectorThreshold) {
        winner = collector;
        winReason = '【集票胜者】触发技能：获得超过 2/3 票数！';
    }

    // --- C. 处决判定 ---
    let maxVotes = 0;
    Object.values(voteCounts).forEach(c => { if (c > maxVotes) maxVotes = c; });
    const candidates = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes).map(Number);
    
    let eliminatedPlayerId = null;

    if (!winner) { // 如果还没人直接赢，才进行处决
        if (maxVotes === 0) {
            logs.push({ message: '今日无人投票。', tag: 'PUBLIC' });
        } else if (candidates.length > 1) {
            // 平票
            const names = candidates.map(id => players.find(p => p.id == id)?.name).join(', ');
            logs.push({ message: `平票！${names} 均获得 ${maxVotes} 票。无人出局。`, tag: 'PUBLIC' });

            // 15. 平票赢家判定
            const tieWinner = players.find(p => p.role === '平票赢家' && p.is_alive && candidates.includes(p.id));
            if (tieWinner) {
                winner = tieWinner;
                winReason = '【平票赢家】触发技能：身处平局之中！';
            }

            // 8. 平票终结者判定 (计数)
            const tieBreaker = players.find(p => p.role === '平票终结者' && p.is_alive);
            if (tieBreaker) {
                const streak = (tieBreaker.flags?.tie_streak || 0) + 1;
                playerUpdates.push({ ...tieBreaker, flags: { ...tieBreaker.flags, tie_streak: streak } }); // 更新计数
                if (streak >= Math.ceil(totalPlayers / 3)) {
                    winner = tieBreaker;
                    winReason = `【平票终结者】触发技能：连续 ${streak} 局平票！`;
                }
            }
        } else {
            // 处决
            eliminatedPlayerId = candidates[0];
            const victim = players.find(p => p.id === eliminatedPlayerId);
            if (victim) {
                playerUpdates.push({ ...victim, is_alive: false, flags: {} });
                logs.push({ message: `玩家【${victim.name}】被处决 (票数: ${maxVotes})。`, tag: 'PUBLIC' });
            }
        }
    }

    // 12. 免票胜者判定 (只要没死，且自己得票为0)
    const zeroVoter = players.find(p => p.role === '免票胜者' && p.is_alive && p.id !== eliminatedPlayerId);
    if (zeroVoter) {
        if (voteCounts[zeroVoter.id] === 0) {
            const streak = (zeroVoter.flags?.no_vote_streak || 0) + 1;
            // 只有当这次更新还没推入过，才推入 (防止和上面的平票更新冲突，虽然不太可能同时是两个角色)
            const existingUpdate = playerUpdates.find(u => u.id === zeroVoter.id);
            if (existingUpdate) {
                existingUpdate.flags.no_vote_streak = streak;
            } else {
                playerUpdates.push({ ...zeroVoter, flags: { ...zeroVoter.flags, no_vote_streak: streak } });
            }
            
            if (streak >= Math.ceil(totalPlayers / 3)) {
                winner = zeroVoter;
                winReason = `【免票胜者】触发技能：连续 ${streak} 局零票！`;
            }
        } else {
            // 被投了，计数归零
            const existingUpdate = playerUpdates.find(u => u.id === zeroVoter.id);
            if (existingUpdate) existingUpdate.flags.no_vote_streak = 0;
            else playerUpdates.push({ ...zeroVoter, flags: { ...zeroVoter.flags, no_vote_streak: 0 } });
        }
    }

    // --- D. 胜负判定 II (死亡触发) ---
    
    // 9. 影子胜者判定
    const shadow = players.find(p => p.role === '影子胜者' && p.is_alive);
    if (shadow && shadow.flags?.shadow_target_id === eliminatedPlayerId) {
        winner = shadow;
        winReason = '【影子胜者】触发技能：目标目标已死亡！';
    }

    // --- E. 最终结算 ---
    let nextState = '';
    const finalAliveCount = players.filter(p => p.is_alive && p.id !== eliminatedPlayerId).length;

    if (winner) {
        nextState = 'GAME OVER';
        logs.push({ message: `🎉 游戏结束！${winReason} 获胜者：${winner.name}`, tag: 'PUBLIC' });
    } else {
        // 11. 三人王者
        const threeKings = players.find(p => p.role === '三人王者' && p.is_alive && p.id !== eliminatedPlayerId);
        if (threeKings && finalAliveCount === 3) {
            nextState = 'GAME OVER';
            logs.push({ message: `🎉 存活 3 人，【三人王者】${threeKings.name} 直接获胜！`, tag: 'PUBLIC' });
        } else if (finalAliveCount <= 2) {
            nextState = 'GAME OVER';
            logs.push({ message: '🚫 存活不足 2 人，游戏结束。', tag: 'PUBLIC' });
        } else {
            nextState = `NIGHT ${currentRoundNum + 1}`;
        }
    }

    // 提交
    if (playerUpdates.length > 0) await supabase.from('players').upsert(playerUpdates);
    await supabase.from('votes').delete().eq('room_code', roomCode); 
    if (logs.length > 0) {
        const logsPayload = logs.map(l => ({ room_code: roomCode, message: l.message, viewer_ids: null, tag: l.tag, created_at: new Date().toISOString() }));
        await supabase.from('game_logs').insert(logsPayload);
    }
    await supabase.from('rooms').update({ round_state: nextState }).eq('code', roomCode);

    res.status(200).json({ success: true, message: '结算完成' });
}